package handlers

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/gorilla/mux"
	"github.com/sirupsen/logrus"

	"waddlebot-bridge/internal/obs"
)

// OBSHandler handles OBS-related endpoints
type OBSHandler struct {
	obsClient *obs.Client
	logger    *logrus.Logger
}

// NewOBSHandler creates a new OBS handler
func NewOBSHandler(obsClient *obs.Client, logger *logrus.Logger) *OBSHandler {
	return &OBSHandler{
		obsClient: obsClient,
		logger:    logger,
	}
}

// ErrorResponse represents an error response
type ErrorResponse struct {
	Error string `json:"error"`
}

// SuccessResponse represents a success response
type SuccessResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message,omitempty"`
}

// GetStatus returns OBS connection status
func (h *OBSHandler) GetStatus(w http.ResponseWriter, r *http.Request) {
	status := map[string]interface{}{
		"connected": h.obsClient.IsConnected(),
		"state":     h.obsClient.GetState().String(),
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(status)
}

// Connect connects to OBS
func (h *OBSHandler) Connect(w http.ResponseWriter, r *http.Request) {
	if err := h.obsClient.Connect(context.Background()); err != nil {
		h.sendError(w, err.Error(), http.StatusInternalServerError)
		return
	}

	h.sendSuccess(w, "Connected to OBS")
}

// Disconnect disconnects from OBS
func (h *OBSHandler) Disconnect(w http.ResponseWriter, r *http.Request) {
	if err := h.obsClient.Disconnect(); err != nil {
		h.sendError(w, err.Error(), http.StatusInternalServerError)
		return
	}

	h.sendSuccess(w, "Disconnected from OBS")
}

// GetScenes returns all scenes
func (h *OBSHandler) GetScenes(w http.ResponseWriter, r *http.Request) {
	scenes, err := h.obsClient.GetScenes(context.Background())
	if err != nil {
		h.sendError(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"scenes": scenes,
	})
}

// GetCurrentScene returns the current scene
func (h *OBSHandler) GetCurrentScene(w http.ResponseWriter, r *http.Request) {
	scene, err := h.obsClient.GetCurrentScene(context.Background())
	if err != nil {
		h.sendError(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(scene)
}

// SwitchSceneRequest represents a scene switch request
type SwitchSceneRequest struct {
	SceneName string `json:"scene_name"`
}

// SwitchScene switches to a different scene
func (h *OBSHandler) SwitchScene(w http.ResponseWriter, r *http.Request) {
	var req SwitchSceneRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.sendError(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if req.SceneName == "" {
		h.sendError(w, "scene_name is required", http.StatusBadRequest)
		return
	}

	if err := h.obsClient.SetCurrentScene(context.Background(), req.SceneName); err != nil {
		h.sendError(w, err.Error(), http.StatusInternalServerError)
		return
	}

	h.sendSuccess(w, "Scene switched to "+req.SceneName)
}

// GetSceneSources returns sources in a scene
func (h *OBSHandler) GetSceneSources(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	sceneName := vars["name"]

	sources, err := h.obsClient.GetSceneSources(context.Background(), sceneName)
	if err != nil {
		h.sendError(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"sources": sources,
	})
}

// SetSourceVisibilityRequest represents a source visibility request
type SetSourceVisibilityRequest struct {
	SceneName string `json:"scene_name"`
	Visible   bool   `json:"visible"`
}

// SetSourceVisibility sets source visibility
func (h *OBSHandler) SetSourceVisibility(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	sourceName := vars["name"]

	var req SetSourceVisibilityRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.sendError(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if req.SceneName == "" {
		h.sendError(w, "scene_name is required", http.StatusBadRequest)
		return
	}

	if err := h.obsClient.SetSourceVisibility(context.Background(), req.SceneName, sourceName, req.Visible); err != nil {
		h.sendError(w, err.Error(), http.StatusInternalServerError)
		return
	}

	h.sendSuccess(w, "Source visibility updated")
}

// SetSourceTransformRequest represents a source transform request
type SetSourceTransformRequest struct {
	SceneName string  `json:"scene_name"`
	X         float64 `json:"x,omitempty"`
	Y         float64 `json:"y,omitempty"`
	ScaleX    float64 `json:"scale_x,omitempty"`
	ScaleY    float64 `json:"scale_y,omitempty"`
	Rotation  float64 `json:"rotation,omitempty"`
}

// SetSourceTransform sets source transform
func (h *OBSHandler) SetSourceTransform(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	sourceName := vars["name"]

	var req SetSourceTransformRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.sendError(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if req.SceneName == "" {
		h.sendError(w, "scene_name is required", http.StatusBadRequest)
		return
	}

	// Build transform
	transform := obs.SourceTransform{}
	if req.X != 0 || req.Y != 0 {
		transform.PositionX = &req.X
		transform.PositionY = &req.Y
	}
	if req.ScaleX != 0 {
		transform.ScaleX = &req.ScaleX
	}
	if req.ScaleY != 0 {
		transform.ScaleY = &req.ScaleY
	}
	if req.Rotation != 0 {
		transform.Rotation = &req.Rotation
	}

	if err := h.obsClient.SetSourceTransform(context.Background(), req.SceneName, sourceName, transform); err != nil {
		h.sendError(w, err.Error(), http.StatusInternalServerError)
		return
	}

	h.sendSuccess(w, "Source transform updated")
}

// GetSourceFilters returns filters for a source
func (h *OBSHandler) GetSourceFilters(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	sourceName := vars["name"]

	filters, err := h.obsClient.GetSourceFilters(context.Background(), sourceName)
	if err != nil {
		h.sendError(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"filters": filters,
	})
}

// UpdateFilterRequest represents a filter update request
type UpdateFilterRequest struct {
	Enabled  *bool                  `json:"enabled,omitempty"`
	Settings map[string]interface{} `json:"settings,omitempty"`
}

// UpdateFilter updates a filter
func (h *OBSHandler) UpdateFilter(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	sourceName := vars["source"]
	filterName := vars["filter"]

	var req UpdateFilterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.sendError(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	// Update enabled state if provided
	if req.Enabled != nil {
		if err := h.obsClient.SetFilterEnabled(context.Background(), sourceName, filterName, *req.Enabled); err != nil {
			h.sendError(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}

	// Update settings if provided
	if req.Settings != nil {
		if err := h.obsClient.SetFilterSettings(context.Background(), sourceName, filterName, req.Settings); err != nil {
			h.sendError(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}

	h.sendSuccess(w, "Filter updated")
}

// GetStreamStatus returns stream status
func (h *OBSHandler) GetStreamStatus(w http.ResponseWriter, r *http.Request) {
	status, err := h.obsClient.GetStreamStatus(context.Background())
	if err != nil {
		h.sendError(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(status)
}

// StartStream starts streaming
func (h *OBSHandler) StartStream(w http.ResponseWriter, r *http.Request) {
	if err := h.obsClient.StartStream(context.Background()); err != nil {
		h.sendError(w, err.Error(), http.StatusInternalServerError)
		return
	}

	h.sendSuccess(w, "Stream started")
}

// StopStream stops streaming
func (h *OBSHandler) StopStream(w http.ResponseWriter, r *http.Request) {
	if err := h.obsClient.StopStream(context.Background()); err != nil {
		h.sendError(w, err.Error(), http.StatusInternalServerError)
		return
	}

	h.sendSuccess(w, "Stream stopped")
}

// ToggleStream toggles streaming
func (h *OBSHandler) ToggleStream(w http.ResponseWriter, r *http.Request) {
	active, err := h.obsClient.ToggleStream(context.Background())
	if err != nil {
		h.sendError(w, err.Error(), http.StatusInternalServerError)
		return
	}

	message := "Stream started"
	if !active {
		message = "Stream stopped"
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"active":  active,
		"message": message,
	})
}

// GetRecordingStatus returns recording status
func (h *OBSHandler) GetRecordingStatus(w http.ResponseWriter, r *http.Request) {
	status, err := h.obsClient.GetRecordingStatus(context.Background())
	if err != nil {
		h.sendError(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(status)
}

// StartRecording starts recording
func (h *OBSHandler) StartRecording(w http.ResponseWriter, r *http.Request) {
	if err := h.obsClient.StartRecording(context.Background()); err != nil {
		h.sendError(w, err.Error(), http.StatusInternalServerError)
		return
	}

	h.sendSuccess(w, "Recording started")
}

// StopRecording stops recording
func (h *OBSHandler) StopRecording(w http.ResponseWriter, r *http.Request) {
	outputPath, err := h.obsClient.StopRecording(context.Background())
	if err != nil {
		h.sendError(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":     true,
		"message":     "Recording stopped",
		"output_path": outputPath,
	})
}

// PauseRecording pauses recording
func (h *OBSHandler) PauseRecording(w http.ResponseWriter, r *http.Request) {
	if err := h.obsClient.PauseRecording(context.Background()); err != nil {
		h.sendError(w, err.Error(), http.StatusInternalServerError)
		return
	}

	h.sendSuccess(w, "Recording paused")
}

// ResumeRecording resumes recording
func (h *OBSHandler) ResumeRecording(w http.ResponseWriter, r *http.Request) {
	if err := h.obsClient.ResumeRecording(context.Background()); err != nil {
		h.sendError(w, err.Error(), http.StatusInternalServerError)
		return
	}

	h.sendSuccess(w, "Recording resumed")
}

// ToggleRecording toggles recording
func (h *OBSHandler) ToggleRecording(w http.ResponseWriter, r *http.Request) {
	// Get current status first
	status, err := h.obsClient.GetRecordingStatus(context.Background())
	if err != nil {
		h.sendError(w, err.Error(), http.StatusInternalServerError)
		return
	}

	wasActive := status.Active

	// Toggle recording
	if err := h.obsClient.ToggleRecording(context.Background()); err != nil {
		h.sendError(w, err.Error(), http.StatusInternalServerError)
		return
	}

	message := "Recording started"
	nowActive := !wasActive
	if !nowActive {
		message = "Recording stopped"
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"active":  nowActive,
		"message": message,
	})
}

// Helper methods

func (h *OBSHandler) sendError(w http.ResponseWriter, message string, statusCode int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	json.NewEncoder(w).Encode(ErrorResponse{Error: message})
	h.logger.WithField("error", message).Warn("OBS API error")
}

func (h *OBSHandler) sendSuccess(w http.ResponseWriter, message string) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(SuccessResponse{Success: true, Message: message})
}
