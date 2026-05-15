// SAGBI AGI — Go Signaling + Chat Relay Server
// WebSocket signaling for distributed AI agent communication.
// Routes chat messages to the local Ollama instance and returns responses.

package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// ── Configuration ────────────────────────────────────────────
var (
	listenAddr  = envOr("LISTEN_ADDR", ":8080")
	ollamaURL   = envOr("OLLAMA_URL", "http://localhost:11434")
	ollamaModel = envOr("OLLAMA_MODEL", "gemma3:1b-it-q4_K_M")
)

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// ── WebSocket upgrader ───────────────────────────────────────
var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024 * 1024, // 1MB for image payloads
	WriteBufferSize: 1024 * 1024,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

const (
	pingPeriod = 30 * time.Second
)

// ── Client management ────────────────────────────────────────
type Client struct {
	conn *websocket.Conn
	send chan []byte
	role string
	id   string
}

type Hub struct {
	mu      sync.RWMutex
	clients map[*Client]bool
}

var hub = &Hub{clients: make(map[*Client]bool)}

func (h *Hub) register(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.clients[c] = true
	log.Printf("[Hub] Client registered: %s (role=%s)  total=%d", c.id, c.role, len(h.clients))
}

func (h *Hub) unregister(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.clients[c]; ok {
		delete(h.clients, c)
		close(c.send)
		log.Printf("[Hub] Client unregistered: %s  total=%d", c.id, len(h.clients))
	}
}

func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()
	for {
		select {
		case message, ok := <-c.send:
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			// Set write deadline for stability
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.TextMessage, message); err != nil {
				return
			}
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (h *Hub) broadcast(msg []byte, exclude *Client) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients {
		if c == exclude {
			continue
		}
		select {
		case c.send <- msg:
		default:
			// drop slow client
		}
	}
}

// ── Message types ────────────────────────────────────────────
type WSMessage struct {
	Type    string          `json:"type"`
	From    string          `json:"from,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type ChatPayload struct {
	Text  string `json:"text"`
	Image string `json:"image,omitempty"` // Base64 image
	Lang  string `json:"lang,omitempty"`
}

// ── Ollama integration ───────────────────────────────────────
type OllamaRequest struct {
	Model  string   `json:"model"`
	Prompt string   `json:"prompt"`
	Stream bool     `json:"stream"`
	Images []string `json:"images,omitempty"`
}

type OllamaResponse struct {
	Response string `json:"response"`
}

// searchRAG reads text files from the rag/ directory and returns relevant snippets
func searchRAG(query string) string {
	ragDir := "rag"
	_ = os.MkdirAll(ragDir, 0755) // Ensure dir exists
	files, err := os.ReadDir(ragDir)
	if err != nil {
		return ""
	}

	var context bytes.Buffer
	for _, file := range files {
		if !file.IsDir() && (len(file.Name()) > 4 && file.Name()[len(file.Name())-4:] == ".txt") {
			content, err := os.ReadFile(ragDir + "/" + file.Name())
			if err == nil {
				context.WriteString(string(content) + "\n---\n")
			}
		}
	}
	return context.String()
}

func queryOllama(payload ChatPayload) (string, error) {
	prompt := payload.Text

	// Inject RAG context if available
	context := searchRAG(payload.Text)
	if context != "" {
		prompt = "Context information:\n" + context + "\n\nUser Question: " + payload.Text
	}

	ollamaReq := OllamaRequest{
		Model:  ollamaModel,
		Prompt: prompt,
		Stream: false,
	}

	// Add image if present (strip data:image/png;base64, prefix if exists)
	if payload.Image != "" {
		imgData := payload.Image
		if idx := bytes.Index([]byte(imgData), []byte(",")); idx != -1 {
			imgData = imgData[idx+1:]
		}
		ollamaReq.Images = []string{imgData}
	}

	reqBody, _ := json.Marshal(ollamaReq)

	client := &http.Client{Timeout: 300 * time.Second}
	resp, err := client.Post(ollamaURL+"/api/generate", "application/json", bytes.NewReader(reqBody))
	if err != nil {
		return "", fmt.Errorf("ollama request failed: %w", err)
	}
	defer resp.Body.Close()

	var result OllamaResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", fmt.Errorf("failed to decode response: %w", err)
	}

	return result.Response, nil
}

// ── WebSocket handler ────────────────────────────────────────
func handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[WS] Upgrade error: %v", err)
		return
	}

	c := &Client{
		conn: conn,
		send: make(chan []byte, 1024), // Buffer for large messages
		id:   fmt.Sprintf("client-%d", time.Now().UnixNano()),
	}

	hub.register(c)
	defer hub.unregister(c)

	// Keep connection alive with Pong handler
	conn.SetReadLimit(10 * 1024 * 1024) // 10MB limit for base64 images
	conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	// Start writer goroutine
	go c.writePump()

	// Reader loop
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			break
		}
		// Reset deadline on message
		conn.SetReadDeadline(time.Now().Add(60 * time.Second))

		var msg WSMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}

		switch msg.Type {
		case "register":
			var p struct {
				Role string `json:"role"`
			}
			_ = json.Unmarshal(msg.Payload, &p)
			c.role = p.Role
			log.Printf("[WS] %s registered as %s", c.id, c.role)

		case "chat_message":
			var p ChatPayload
			if err := json.Unmarshal(msg.Payload, &p); err != nil {
				continue
			}
			log.Printf("[Chat] %s: %s (image: %v)", c.id, p.Text, p.Image != "")

			// ── SAGBI DANCE FLOOR: 構造化ストーリー蓄積システム ──
			go func(payload ChatPayload, clientID string) {
				ragDir := "rag"
				_ = os.MkdirAll(ragDir, 0755)
				sessionID := time.Now().Format("20060102_150405")
				filename := fmt.Sprintf("%s/story_%s_%s.txt", ragDir, sessionID, clientID)

				// ストーリーの構築
				var story bytes.Buffer
				story.WriteString(fmt.Sprintf("--- SESSION: %s ---\n", sessionID))
				story.WriteString(fmt.Sprintf("[USER:%s] [TYPE:TEXT] %s\n", clientID, payload.Text))
				
				if payload.Image != "" {
					story.WriteString(fmt.Sprintf("[USER:%s] [TYPE:IMAGE] attached\n", clientID))
					// 画像ファイルは別途保存し、ストーリーからリンク
					imgData := payload.Image
					if idx := bytes.Index([]byte(imgData), []byte(",")); idx != -1 {
						imgData = imgData[idx+1:]
					}
					decoded, _ := base64.StdEncoding.DecodeString(imgData)
					imgFilename := fmt.Sprintf("%s/media_%s_%s.jpg", ragDir, sessionID, clientID)
					_ = os.WriteFile(imgFilename, decoded, 0644)
					story.WriteString(fmt.Sprintf("[LINK:IMAGE] %s\n", imgFilename))
				}

				// AIの回答もストーリーに加えるために、queryOllama後に追記する仕組みへ
				go func(client *Client, p ChatPayload, st *bytes.Buffer, fName string) {
					answer, err := queryOllama(p)
					if err != nil {
						answer = "AI接続エラー"
					}
					
					// ストーリーにAIの回答を追記
					st.WriteString(fmt.Sprintf("[AI:Sagbi] [TYPE:TEXT] %s\n", answer))
					st.WriteString("--- END SESSION ---\n")
					_ = os.WriteFile(fName, st.Bytes(), 0644)

					// クライアントへ送信
					resp := WSMessage{Type: "chat_response", From: "SAGBI DANCE FLOOR"}
					respPayload, _ := json.Marshal(ChatPayload{Text: answer})
					resp.Payload = respPayload
					respBytes, _ := json.Marshal(resp)
					select {
					case client.send <- respBytes:
					default:
					}
				}(c, p, &story, filename)
			}(p, c.id)
		
		case "signal":
			// Forward signaling messages (offer/answer/candidate) to target
			hub.broadcast(raw, c)

		default:
			log.Printf("[WS] Unknown message type: %s", msg.Type)
		}
	}
}

// ── HTTP handlers ────────────────────────────────────────────
func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	hub.mu.RLock()
	count := len(hub.clients)
	hub.mu.RUnlock()
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "ok",
		"clients": count,
		"model":   ollamaModel,
	})
}

// ── Main ─────────────────────────────────────────────────────
func main() {
	mux := http.NewServeMux()

	mux.HandleFunc("/ws/chat", handleWS)
	mux.HandleFunc("/healthz", healthHandler)

	// Serve static files (optional, for local dev)
	fs := http.FileServer(http.Dir("./static"))
	mux.Handle("/", fs)

	log.Printf("🚀 SAGBI Signaling Server starting on %s", listenAddr)
	log.Printf("   Ollama endpoint: %s (model: %s)", ollamaURL, ollamaModel)

	srv := &http.Server{
		Addr:         listenAddr,
		Handler:      mux,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 120 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("Server error: %v", err)
	}
}
