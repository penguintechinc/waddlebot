package gateway

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/mux"
	"github.com/sirupsen/logrus"
	"golang.org/x/time/rate"

	"waddlebot-bridge/internal/config"
	"waddlebot-bridge/internal/obs"
)

// Gateway represents the local API gateway server
type Gateway struct {
	config        config.GatewayConfig
	server        *http.Server
	router        *mux.Router
	obsClient     *obs.Client
	logger        *logrus.Logger
	rateLimiters  map[string]*rate.Limiter
	limiterMux    sync.RWMutex
	wsHub         *WebSocketHub
	running       bool
	runningMux    sync.RWMutex
}

// New creates a new Gateway instance
func New(cfg config.GatewayConfig, obsClient *obs.Client, logger *logrus.Logger) *Gateway {
	g := &Gateway{
		config:       cfg,
		obsClient:    obsClient,
		logger:       logger,
		rateLimiters: make(map[string]*rate.Limiter),
		wsHub:        NewWebSocketHub(logger),
	}

	g.setupRouter()
	return g
}

// setupRouter initializes the HTTP router with middleware and routes
func (g *Gateway) setupRouter() {
	g.router = mux.NewRouter()

	// Apply global middleware
	g.router.Use(g.loggingMiddleware)
	if g.config.EnableAuth {
		g.router.Use(g.authMiddleware)
	}
	g.router.Use(g.rateLimitMiddleware)
	if g.config.EnableCORS {
		g.router.Use(g.corsMiddleware)
	}

	// Register all routes
	RegisterRoutes(g)
}

// Start starts the gateway server
func (g *Gateway) Start(ctx context.Context) error {
	g.runningMux.Lock()
	if g.running {
		g.runningMux.Unlock()
		return fmt.Errorf("gateway already running")
	}
	g.running = true
	g.runningMux.Unlock()

	// Start WebSocket hub
	go g.wsHub.Run()

	// Create HTTP server
	addr := fmt.Sprintf("%s:%d", g.config.Host, g.config.Port)
	g.server = &http.Server{
		Addr:         addr,
		Handler:      g.router,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	g.logger.WithFields(logrus.Fields{
		"host": g.config.Host,
		"port": g.config.Port,
		"auth": g.config.EnableAuth,
		"cors": g.config.EnableCORS,
	}).Info("Starting local API gateway")

	// Start server in goroutine
	errChan := make(chan error, 1)
	go func() {
		if err := g.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errChan <- err
		}
	}()

	// Wait for context cancellation or error
	select {
	case <-ctx.Done():
		return g.Stop()
	case err := <-errChan:
		g.runningMux.Lock()
		g.running = false
		g.runningMux.Unlock()
		return err
	}
}

// Stop gracefully stops the gateway server
func (g *Gateway) Stop() error {
	g.runningMux.Lock()
	if !g.running {
		g.runningMux.Unlock()
		return nil
	}
	g.running = false
	g.runningMux.Unlock()

	g.logger.Info("Stopping local API gateway")

	// Stop WebSocket hub
	g.wsHub.Stop()

	// Shutdown HTTP server with timeout
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := g.server.Shutdown(ctx); err != nil {
		g.logger.WithError(err).Error("Error shutting down gateway server")
		return err
	}

	g.logger.Info("Gateway stopped successfully")
	return nil
}

// IsRunning returns whether the gateway is currently running
func (g *Gateway) IsRunning() bool {
	g.runningMux.RLock()
	defer g.runningMux.RUnlock()
	return g.running
}

// GetRouter returns the HTTP router
func (g *Gateway) GetRouter() *mux.Router {
	return g.router
}

// GetOBSClient returns the OBS client
func (g *Gateway) GetOBSClient() *obs.Client {
	return g.obsClient
}

// GetLogger returns the logger
func (g *Gateway) GetLogger() *logrus.Logger {
	return g.logger
}

// GetWebSocketHub returns the WebSocket hub
func (g *Gateway) GetWebSocketHub() *WebSocketHub {
	return g.wsHub
}

// BroadcastEvent sends an event to all WebSocket clients
func (g *Gateway) BroadcastEvent(eventType string, data interface{}) {
	g.wsHub.Broadcast(WSMessage{
		Type: eventType,
		Data: data,
	})
}
