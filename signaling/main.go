// SAGBI AGI — Go Signaling + Chat Relay Server
// WebSocket signaling for distributed AI agent communication.
// Routes chat messages to the local Ollama instance and returns responses.

package main

import (
	"bytes"
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
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

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
		close(c.send)
		delete(h.clients, c)
		log.Printf("[Hub] Client left: %s  total=%d", c.id, len(h.clients))
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
	Text string `json:"text"`
}

// ── Ollama integration ───────────────────────────────────────
type OllamaRequest struct {
	Model  string `json:"model"`
	Prompt string `json:"prompt"`
	Stream bool   `json:"stream"`
}

type OllamaResponse struct {
	Response string `json:"response"`
}

func queryOllama(prompt string) (string, error) {
	reqBody, _ := json.Marshal(OllamaRequest{
		Model:  ollamaModel,
		Prompt: prompt,
		Stream: false,
	})

	client := &http.Client{Timeout: 300 * time.Second}
	resp, err := client.Post(ollamaURL+"/api/generate", "application/json", bytes.NewReader(reqBody))
	if err != nil {
		return "", fmt.Errorf("ollama request failed: %w", err)
	}
	defer resp.Body.Close()

	var result OllamaResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", fmt.Errorf("ollama decode error: %w", err)
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
		send: make(chan []byte, 64),
		id:   fmt.Sprintf("client-%d", time.Now().UnixNano()),
	}

	hub.register(c)
	defer hub.unregister(c)

	// Writer goroutine
	go func() {
		defer conn.Close()
		for msg := range c.send {
			if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		}
	}()

	// Reader loop
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			break
		}

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
			if err := json.Unmarshal(msg.Payload, &p); err != nil || p.Text == "" {
				continue
			}
			log.Printf("[Chat] %s: %s", c.id, p.Text)

			// Query Ollama in background
			go func(client *Client, question string) {
				answer, err := queryOllama(question)
				if err != nil {
					log.Printf("[Ollama] Error: %v", err)
					answer = "申し訳ありません、AIサービスに接続できませんでした。"
				}

				resp := WSMessage{
					Type: "chat_response",
					From: "sagbi-agi",
				}
				payload, _ := json.Marshal(ChatPayload{Text: answer})
				resp.Payload = payload
				respBytes, _ := json.Marshal(resp)

				select {
				case client.send <- respBytes:
				default:
				}
			}(c, p.Text)

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
