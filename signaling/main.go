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
	"path/filepath"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// ── Configuration ────────────────────────────────────────────
var (
	listenAddr  = envOr("LISTEN_ADDR", ":8080")
	ollamaURL   = envOr("OLLAMA_URL", "http://localhost:11434")
	ollamaModel = envOr("OLLAMA_MODEL", "gemma3:4b-it-q4_K_M")
	// RAG_DIR 環境変数を参照。設定されていなければRAG機能はデフォルトで無効。
	ragSourceDir = envOr("RAG_DIR", "")
	// HISTORY_DIR 環境変数を参照。設定されていなければ履歴保存は無効。
	historyDir = envOr("HISTORY_DIR", "")
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
	ID    string `json:"id,omitempty"` // メッセージの同一性を識別するためのID
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
// RAG_DIR 環境変数が設定されていればそのディレクトリを参照する
func searchRAG(query string) string {
	// ragSourceDir が設定されていなければ、RAG機能は無効
	if ragSourceDir == "" {
		return ""
	}

	files, err := os.ReadDir(ragSourceDir)
	if err != nil {
		log.Printf("Warning: Could not read RAG directory '%s'. Please ensure it exists and has correct permissions: %v", ragSourceDir, err)
		return ""
	}

	var context bytes.Buffer
	for _, file := range files {
		// .txt または .md ファイルを対象
		if !file.IsDir() && (filepath.Ext(file.Name()) == ".txt" || filepath.Ext(file.Name()) == ".md") {
			content, err := os.ReadFile(filepath.Join(ragSourceDir, file.Name()))
			if err == nil {
				context.WriteString(fmt.Sprintf("--- File: %s ---\n%s\n", file.Name(), string(content)))
			}
		}
	}
	return context.String()
}

// queryOllama now accepts a callback to stream tokens back to the client
func queryOllama(payload ChatPayload, onChunk func(string)) error {
	// AIがユーザーの質問を繰り返さず、直接回答するように指示を追加
	prompt := "User's request: " + payload.Text + "\n\nInstructions: Answer directly. Do not repeat the user's prompt."

	// Inject RAG context if available
	context := searchRAG(payload.Text) // TODO: Optimize RAG to not read files every time
	if context != "" {
		prompt = "Context information:\n" + context + "\n\nUser Question: " + payload.Text + "\n\nAnswer directly based on the context above."
	}

	ollamaReq := OllamaRequest{
		Model:  ollamaModel,
		Prompt: prompt,
		Stream: true, // Enable streaming
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

	// Ollamaのロードが極端に遅い場合に対応するため、トランスポートレベルでタイムアウトを制御
	client := &http.Client{
		Timeout: 3000 * time.Second,
		Transport: &http.Transport{
			ResponseHeaderTimeout: 3000 * time.Second,
		},
	}
	resp, err := client.Post(ollamaURL+"/api/generate", "application/json", bytes.NewReader(reqBody))
	if err != nil {
		return fmt.Errorf("ollama request failed: %w", err)
	}
	defer resp.Body.Close()

	// Decode streaming JSON from Ollama
	decoder := json.NewDecoder(resp.Body)
	for {
		var chunk struct {
			Response string `json:"response"`
			Done     bool   `json:"done"`
		}
		if err := decoder.Decode(&chunk); err != nil {
			if err.Error() == "EOF" {
				break
			}
			return fmt.Errorf("failed to decode chunk: %w", err)
		}

		if chunk.Response != "" {
			onChunk(chunk.Response)
		}
		if chunk.Done {
			break
		}
	}
	return nil
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
	conn.SetReadLimit(10 * 1024 * 1024)                      // 10MB limit for base64 images
	conn.SetReadDeadline(time.Now().Add(3000 * time.Second)) // 5分まで許容
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(3000 * time.Second))
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
			// 自分のIDを通知する
			regMsg, _ := json.Marshal(WSMessage{
				Type:    "registered",
				Payload: json.RawMessage(fmt.Sprintf(`{"id":"%s"}`, c.id)),
			})
			c.send <- regMsg
			log.Printf("[WS] %s registered as %s", c.id, c.role)

		case "log":
			var l string
			_ = json.Unmarshal(msg.Payload, &l)
			fmt.Printf("[BROWSER] %s\n", l)

		case "chat_message":
			var p ChatPayload
			if err := json.Unmarshal(msg.Payload, &p); err != nil {
				continue
			}
			log.Printf("[Chat] %s: %s (image: %v)", c.id, p.Text, p.Image != "")

			// 質問の同期：ユーザーの質問をそのまま chat_message 型として他者に転送する。
			// 型を分けることで、エージェントが自分の発言に反応するのを防ぎます。
			msg.From = "User (" + c.id + ")"
			// 送信元にIDを付与（任意）
			p.ID = fmt.Sprintf("user-%d", time.Now().UnixNano())
			msg.Payload, _ = json.Marshal(p)
			broadcastRaw, _ := json.Marshal(msg)
			hub.broadcast(broadcastRaw, c)

			// ── SAGBI DANCE FLOOR: 構造化ストーリー蓄積システム ──
			go func(payload ChatPayload, clientID string) {
				var story bytes.Buffer
				sessionID := time.Now().Format("20060102_150405")
				filename := ""

				if historyDir == "" {
					log.Printf("[Chat] History storage disabled (HISTORY_DIR not set).")
				} else {
					_ = os.MkdirAll(historyDir, 0755)
					filename = filepath.Join(historyDir, fmt.Sprintf("story_%s_%s.txt", sessionID, clientID))

					story.WriteString(fmt.Sprintf("--- SESSION: %s ---\n", sessionID))
					story.WriteString(fmt.Sprintf("[USER:%s] %s\n", clientID, payload.Text))

					if payload.Image != "" {
						story.WriteString(fmt.Sprintf("[USER:%s] [IMAGE] attached\n", clientID))
						imgData := payload.Image
						if idx := bytes.Index([]byte(imgData), []byte(",")); idx != -1 {
							imgData = imgData[idx+1:]
						}
						decoded, _ := base64.StdEncoding.DecodeString(imgData)
						imgFilename := filepath.Join(historyDir, fmt.Sprintf("media_%s_%s.jpg", sessionID, clientID))
						_ = os.WriteFile(imgFilename, decoded, 0644)
						story.WriteString(fmt.Sprintf("[LINK:IMAGE] %s\n", imgFilename))
					}
				}

				// AI回答生成
				var fullAnswer bytes.Buffer
				respMsg := WSMessage{
					Type: "chat_response",
					From: "SAGBI AI",
				}
				aiResponseID := fmt.Sprintf("ai-%d", time.Now().UnixNano())

				err := queryOllama(payload, func(chunk string) {
					fullAnswer.WriteString(chunk)
					// 逐次ブロードキャスト
					respMsg.Payload, _ = json.Marshal(ChatPayload{Text: chunk, ID: aiResponseID})
					respBytes, _ := json.Marshal(respMsg)
					hub.broadcast(respBytes, nil)
				})

				if err != nil {
					log.Printf("[Error] Ollama: %v", err)
					errMsg := fmt.Sprintf("AI接続エラー: %v", err)
					fullAnswer.WriteString(errMsg)
					respMsg.Payload, _ = json.Marshal(ChatPayload{Text: errMsg})
					respBytes, _ := json.Marshal(respMsg)
					hub.broadcast(respBytes, nil)
				}

				// 回答完了後に履歴を書き出し
				if filename != "" {
					story.WriteString(fmt.Sprintf("[AI:Sagbi] %s\n", fullAnswer.String()))
					story.WriteString("--- END SESSION ---\n")
					if err := os.WriteFile(filename, story.Bytes(), 0644); err != nil {
						log.Printf("[Error] Save history failed: %v", err)
					}
				}
			}(p, c.id)

		case "signal":
			// 送信元IDを付与して転送（WebRTC同期に必須）
			msg.From = c.id
			enrichedRaw, _ := json.Marshal(msg)
			hub.broadcast(enrichedRaw, c)

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

	if ragSourceDir != "" {
		log.Printf("   RAG Source Directory: %s", ragSourceDir)
	} else {
		log.Printf("   RAG Source Directory: Not configured (RAG functionality disabled by default).")
	}
	srv := &http.Server{
		Addr:    listenAddr,
		Handler: mux,
		// WebSocket接続を維持するため、サーバー全体のタイムアウトは設定しない
		ReadTimeout:  0,
		WriteTimeout: 0,
		IdleTimeout:  0,
	}

	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("Server error: %v", err)
	}
}
