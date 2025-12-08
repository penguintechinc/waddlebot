package handlers

import (
	"encoding/json"
	"net/http"
	"sync"

	"github.com/gorilla/mux"
	"github.com/sirupsen/logrus"
)

// WebhookHandler handles webhook-related endpoints
type WebhookHandler struct {
	logger   *logrus.Logger
	webhooks map[string]*Webhook
	mu       sync.RWMutex
}

// Webhook represents a registered webhook
type Webhook struct {
	ID     string   `json:"id"`
	URL    string   `json:"url"`
	Events []string `json:"events"`
	Secret string   `json:"secret,omitempty"`
}

// NewWebhookHandler creates a new webhook handler
func NewWebhookHandler(logger *logrus.Logger) *WebhookHandler {
	return &WebhookHandler{
		logger:   logger,
		webhooks: make(map[string]*Webhook),
	}
}

// ListWebhooks returns all registered webhooks
func (h *WebhookHandler) ListWebhooks(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	webhooks := make([]*Webhook, 0, len(h.webhooks))
	for _, wh := range h.webhooks {
		// Don't expose secrets
		wh.Secret = ""
		webhooks = append(webhooks, wh)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"webhooks": webhooks,
	})
}

// RegisterWebhookRequest represents a webhook registration request
type RegisterWebhookRequest struct {
	URL    string   `json:"url"`
	Events []string `json:"events"`
	Secret string   `json:"secret,omitempty"`
}

// RegisterWebhook registers a new webhook
func (h *WebhookHandler) RegisterWebhook(w http.ResponseWriter, r *http.Request) {
	var req RegisterWebhookRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.sendError(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if req.URL == "" {
		h.sendError(w, "url is required", http.StatusBadRequest)
		return
	}

	if len(req.Events) == 0 {
		h.sendError(w, "at least one event is required", http.StatusBadRequest)
		return
	}

	// Generate ID (simple implementation)
	h.mu.Lock()
	id := generateID()
	webhook := &Webhook{
		ID:     id,
		URL:    req.URL,
		Events: req.Events,
		Secret: req.Secret,
	}
	h.webhooks[id] = webhook
	h.mu.Unlock()

	h.logger.WithFields(logrus.Fields{
		"id":     id,
		"url":    req.URL,
		"events": req.Events,
	}).Info("Webhook registered")

	// Don't return secret in response
	webhook.Secret = ""

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(webhook)
}

// RemoveWebhook removes a registered webhook
func (h *WebhookHandler) RemoveWebhook(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	id := vars["id"]

	h.mu.Lock()
	_, exists := h.webhooks[id]
	if !exists {
		h.mu.Unlock()
		h.sendError(w, "webhook not found", http.StatusNotFound)
		return
	}

	delete(h.webhooks, id)
	h.mu.Unlock()

	h.logger.WithField("id", id).Info("Webhook removed")

	h.sendSuccess(w, "Webhook removed")
}

// TestWebhook tests a webhook delivery
func (h *WebhookHandler) TestWebhook(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	id := vars["id"]

	h.mu.RLock()
	webhook, exists := h.webhooks[id]
	h.mu.RUnlock()

	if !exists {
		h.sendError(w, "webhook not found", http.StatusNotFound)
		return
	}

	// TODO: Implement actual webhook delivery test
	h.logger.WithFields(logrus.Fields{
		"id":  id,
		"url": webhook.URL,
	}).Info("Testing webhook delivery")

	h.sendSuccess(w, "Test webhook sent to "+webhook.URL)
}

// Helper methods

func (h *WebhookHandler) sendError(w http.ResponseWriter, message string, statusCode int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	json.NewEncoder(w).Encode(ErrorResponse{Error: message})
}

func (h *WebhookHandler) sendSuccess(w http.ResponseWriter, message string) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(SuccessResponse{Success: true, Message: message})
}

// generateID generates a simple webhook ID
func generateID() string {
	// TODO: Use proper UUID generation
	return "webhook_" + string(rune(len("temp")))
}
