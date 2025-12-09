package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/sirupsen/logrus"
)

// BridgeHandler handles bridge-related endpoints
type BridgeHandler struct {
	logger *logrus.Logger
}

// NewBridgeHandler creates a new bridge handler
func NewBridgeHandler(logger *logrus.Logger) *BridgeHandler {
	return &BridgeHandler{
		logger: logger,
	}
}

// BridgeStatus represents bridge status information
type BridgeStatus struct {
	Status    string `json:"status"`
	Version   string `json:"version"`
	Uptime    int64  `json:"uptime"`
	Connected bool   `json:"connected"`
}

// GetStatus returns the current bridge status
func (h *BridgeHandler) GetStatus(w http.ResponseWriter, r *http.Request) {
	status := BridgeStatus{
		Status:    "running",
		Version:   "1.0.0", // TODO: Get from config
		Uptime:    int64(time.Since(time.Now()).Seconds()),
		Connected: true, // TODO: Get from bridge client
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(status)
}

// HealthResponse represents a health check response
type HealthResponse struct {
	Healthy   bool              `json:"healthy"`
	Timestamp int64             `json:"timestamp"`
	Services  map[string]string `json:"services"`
}

// GetHealth returns health check information
func (h *BridgeHandler) GetHealth(w http.ResponseWriter, r *http.Request) {
	health := HealthResponse{
		Healthy:   true,
		Timestamp: time.Now().Unix(),
		Services: map[string]string{
			"gateway": "ok",
			"bridge":  "ok",
		},
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(health)
}

// ReconnectResponse represents a reconnection response
type ReconnectResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
}

// Reconnect forces a bridge reconnection
func (h *BridgeHandler) Reconnect(w http.ResponseWriter, r *http.Request) {
	// TODO: Implement bridge reconnection logic

	response := ReconnectResponse{
		Success: true,
		Message: "Reconnection initiated",
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)

	h.logger.Info("Bridge reconnection requested")
}
