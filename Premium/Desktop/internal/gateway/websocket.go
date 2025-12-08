package gateway

import (
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/sirupsen/logrus"
)

// WebSocketHub manages WebSocket connections and broadcasts
type WebSocketHub struct {
	clients    map[*WebSocketClient]bool
	broadcast  chan WSMessage
	register   chan *WebSocketClient
	unregister chan *WebSocketClient
	logger     *logrus.Logger
	running    bool
	runningMux sync.RWMutex
}

// WebSocketClient represents a connected WebSocket client
type WebSocketClient struct {
	hub  *WebSocketHub
	conn *websocket.Conn
	send chan WSMessage
}

// WSMessage represents a WebSocket message
type WSMessage struct {
	Type      string      `json:"type"`
	Data      interface{} `json:"data"`
	Timestamp int64       `json:"timestamp"`
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		// Allow all origins for local gateway
		return true
	},
}

// NewWebSocketHub creates a new WebSocket hub
func NewWebSocketHub(logger *logrus.Logger) *WebSocketHub {
	return &WebSocketHub{
		clients:    make(map[*WebSocketClient]bool),
		broadcast:  make(chan WSMessage, 256),
		register:   make(chan *WebSocketClient),
		unregister: make(chan *WebSocketClient),
		logger:     logger,
	}
}

// Run starts the WebSocket hub
func (h *WebSocketHub) Run() {
	h.runningMux.Lock()
	h.running = true
	h.runningMux.Unlock()

	h.logger.Info("WebSocket hub started")

	for {
		select {
		case client := <-h.register:
			h.clients[client] = true
			h.logger.WithField("client_count", len(h.clients)).Debug("WebSocket client registered")

		case client := <-h.unregister:
			if _, ok := h.clients[client]; ok {
				delete(h.clients, client)
				close(client.send)
				h.logger.WithField("client_count", len(h.clients)).Debug("WebSocket client unregistered")
			}

		case message := <-h.broadcast:
			// Add timestamp if not set
			if message.Timestamp == 0 {
				message.Timestamp = time.Now().Unix()
			}

			// Broadcast to all clients
			for client := range h.clients {
				select {
				case client.send <- message:
				default:
					// Client send channel full, close connection
					close(client.send)
					delete(h.clients, client)
				}
			}
		}
	}
}

// Stop stops the WebSocket hub
func (h *WebSocketHub) Stop() {
	h.runningMux.Lock()
	defer h.runningMux.Unlock()

	if !h.running {
		return
	}

	h.running = false

	// Close all client connections
	for client := range h.clients {
		client.conn.Close()
		close(client.send)
	}

	h.clients = make(map[*WebSocketClient]bool)
	h.logger.Info("WebSocket hub stopped")
}

// Broadcast sends a message to all connected clients
func (h *WebSocketHub) Broadcast(message WSMessage) {
	h.runningMux.RLock()
	defer h.runningMux.RUnlock()

	if !h.running {
		return
	}

	select {
	case h.broadcast <- message:
	default:
		h.logger.Warn("WebSocket broadcast channel full, message dropped")
	}
}

// handleWebSocket handles WebSocket connection upgrade and lifecycle
func (g *Gateway) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	// Upgrade connection
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		g.logger.WithError(err).Error("Failed to upgrade WebSocket connection")
		return
	}

	// Create client
	client := &WebSocketClient{
		hub:  g.wsHub,
		conn: conn,
		send: make(chan WSMessage, 256),
	}

	// Register client
	client.hub.register <- client

	// Start goroutines
	go client.writePump()
	go client.readPump()

	g.logger.WithField("remote_addr", r.RemoteAddr).Info("WebSocket connection established")
}

const (
	// Time allowed to write a message to the peer
	writeWait = 10 * time.Second

	// Time allowed to read the next pong message from the peer
	pongWait = 60 * time.Second

	// Send pings to peer with this period (must be less than pongWait)
	pingPeriod = (pongWait * 9) / 10

	// Maximum message size allowed from peer
	maxMessageSize = 512 * 1024 // 512KB
)

// readPump pumps messages from the WebSocket connection to the hub
func (c *WebSocketClient) readPump() {
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()

	c.conn.SetReadLimit(maxMessageSize)
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, message, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				c.hub.logger.WithError(err).Error("WebSocket read error")
			}
			break
		}

		// Log received message (clients typically only send pings)
		c.hub.logger.WithField("message", string(message)).Debug("WebSocket message received")
	}
}

// writePump pumps messages from the hub to the WebSocket connection
func (c *WebSocketClient) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				// Hub closed the channel
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			// Write JSON message
			if err := c.conn.WriteJSON(message); err != nil {
				c.hub.logger.WithError(err).Error("Failed to write WebSocket message")
				return
			}

		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// SendToClient sends a message to a specific client
func (c *WebSocketClient) SendMessage(message WSMessage) error {
	if message.Timestamp == 0 {
		message.Timestamp = time.Now().Unix()
	}

	select {
	case c.send <- message:
		return nil
	default:
		return websocket.ErrCloseSent
	}
}

// GetConnectedClients returns the number of connected WebSocket clients
func (h *WebSocketHub) GetConnectedClients() int {
	h.runningMux.RLock()
	defer h.runningMux.RUnlock()
	return len(h.clients)
}
