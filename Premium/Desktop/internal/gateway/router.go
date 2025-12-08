package gateway

import (
	"net/http"

	"waddlebot-bridge/internal/gateway/handlers"
)

// RegisterRoutes registers all API routes with the gateway
func RegisterRoutes(g *Gateway) {
	// Create handler instances
	bridgeHandler := handlers.NewBridgeHandler(g.logger)
	obsHandler := handlers.NewOBSHandler(g.obsClient, g.logger)
	webhookHandler := handlers.NewWebhookHandler(g.logger)

	// Health check (no auth required)
	g.router.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`))
	}).Methods("GET")

	// API v1 routes
	api := g.router.PathPrefix("/api/v1").Subrouter()

	// Bridge endpoints
	bridge := api.PathPrefix("/bridge").Subrouter()
	bridge.HandleFunc("/status", bridgeHandler.GetStatus).Methods("GET")
	bridge.HandleFunc("/health", bridgeHandler.GetHealth).Methods("GET")
	bridge.HandleFunc("/reconnect", bridgeHandler.Reconnect).Methods("POST")

	// OBS Control endpoints
	obs := api.PathPrefix("/obs").Subrouter()

	// OBS Connection
	obs.HandleFunc("/status", obsHandler.GetStatus).Methods("GET")
	obs.HandleFunc("/connect", obsHandler.Connect).Methods("POST")
	obs.HandleFunc("/disconnect", obsHandler.Disconnect).Methods("POST")

	// OBS Scenes
	obs.HandleFunc("/scenes", obsHandler.GetScenes).Methods("GET")
	obs.HandleFunc("/scenes/current", obsHandler.GetCurrentScene).Methods("GET")
	obs.HandleFunc("/scenes/switch", obsHandler.SwitchScene).Methods("POST")
	obs.HandleFunc("/scenes/{name}/sources", obsHandler.GetSceneSources).Methods("GET")

	// OBS Sources
	obs.HandleFunc("/sources/{name}/visibility", obsHandler.SetSourceVisibility).Methods("PUT")
	obs.HandleFunc("/sources/{name}/transform", obsHandler.SetSourceTransform).Methods("PUT")
	obs.HandleFunc("/sources/{name}/filters", obsHandler.GetSourceFilters).Methods("GET")

	// OBS Filters
	obs.HandleFunc("/filters/{source}/{filter}", obsHandler.UpdateFilter).Methods("PUT")

	// OBS Streaming
	obs.HandleFunc("/stream/status", obsHandler.GetStreamStatus).Methods("GET")
	obs.HandleFunc("/stream/start", obsHandler.StartStream).Methods("POST")
	obs.HandleFunc("/stream/stop", obsHandler.StopStream).Methods("POST")
	obs.HandleFunc("/stream/toggle", obsHandler.ToggleStream).Methods("POST")

	// OBS Recording
	obs.HandleFunc("/recording/status", obsHandler.GetRecordingStatus).Methods("GET")
	obs.HandleFunc("/recording/start", obsHandler.StartRecording).Methods("POST")
	obs.HandleFunc("/recording/stop", obsHandler.StopRecording).Methods("POST")
	obs.HandleFunc("/recording/pause", obsHandler.PauseRecording).Methods("POST")
	obs.HandleFunc("/recording/resume", obsHandler.ResumeRecording).Methods("POST")
	obs.HandleFunc("/recording/toggle", obsHandler.ToggleRecording).Methods("POST")

	// Webhook endpoints
	webhooks := api.PathPrefix("/webhooks").Subrouter()
	webhooks.HandleFunc("", webhookHandler.ListWebhooks).Methods("GET")
	webhooks.HandleFunc("", webhookHandler.RegisterWebhook).Methods("POST")
	webhooks.HandleFunc("/{id}", webhookHandler.RemoveWebhook).Methods("DELETE")
	webhooks.HandleFunc("/{id}/test", webhookHandler.TestWebhook).Methods("POST")

	// WebSocket endpoint
	g.router.HandleFunc("/ws", g.handleWebSocket).Methods("GET")

	g.logger.Info("Registered all gateway routes")
}
