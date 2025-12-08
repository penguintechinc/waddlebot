package obs

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/andreykaipov/goobs"
	"github.com/google/uuid"
	"github.com/sirupsen/logrus"
)

// Client manages the OBS WebSocket connection
type Client struct {
	config     Config
	client     *goobs.Client
	logger     *logrus.Logger
	state      ConnectionState
	stateMux   sync.RWMutex
	connInfo   ConnectionInfo
	connInfoMux sync.RWMutex

	// Event handling
	eventCallbacks map[SubscriptionID]eventSubscription
	callbackMux    sync.RWMutex

	// Reconnection
	reconnectChan chan struct{}
	stopReconnect chan struct{}

	// Lifecycle
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// eventSubscription holds callback and filter info
type eventSubscription struct {
	callback   EventCallback
	eventTypes []EventType // empty = all events
}

// NewClient creates a new OBS client with the given configuration
func NewClient(cfg Config, logger *logrus.Logger) *Client {
	if logger == nil {
		logger = logrus.New()
	}

	ctx, cancel := context.WithCancel(context.Background())

	return &Client{
		config:         cfg,
		logger:         logger,
		state:          StateDisconnected,
		eventCallbacks: make(map[SubscriptionID]eventSubscription),
		reconnectChan:  make(chan struct{}, 1),
		stopReconnect:  make(chan struct{}),
		ctx:            ctx,
		cancel:         cancel,
		connInfo: ConnectionInfo{
			State: StateDisconnected,
		},
	}
}

// Connect establishes a connection to OBS
func (c *Client) Connect(ctx context.Context) error {
	c.stateMux.Lock()
	if c.state == StateConnected {
		c.stateMux.Unlock()
		return nil
	}
	c.setState(StateConnecting)
	c.stateMux.Unlock()

	c.logger.WithFields(logrus.Fields{
		"host": c.config.Host,
		"port": c.config.Port,
	}).Info("Connecting to OBS")

	// Build connection options
	addr := fmt.Sprintf("%s:%d", c.config.Host, c.config.Port)
	opts := []goobs.Option{}

	if c.config.Password != "" {
		opts = append(opts, goobs.WithPassword(c.config.Password))
	}

	// Create connection with timeout
	connectCtx, cancel := context.WithTimeout(ctx, c.config.Timeout)
	defer cancel()

	// Channel to receive connection result
	type connResult struct {
		client *goobs.Client
		err    error
	}
	resultCh := make(chan connResult, 1)

	go func() {
		client, err := goobs.New(addr, opts...)
		resultCh <- connResult{client: client, err: err}
	}()

	select {
	case <-connectCtx.Done():
		c.setStateAndError(StateDisconnected, "connection timeout")
		return ErrTimeout
	case result := <-resultCh:
		if result.err != nil {
			c.setStateAndError(StateDisconnected, result.err.Error())
			return NewOBSError(ErrConnectionFailed, result.err.Error())
		}
		c.client = result.client
	}

	// Get version info
	version, err := c.client.General.GetVersion()
	if err != nil {
		c.logger.WithError(err).Warn("Failed to get OBS version")
	} else {
		c.connInfoMux.Lock()
		c.connInfo.OBSVersion = version.ObsVersion
		c.connInfo.WebSocketVersion = version.ObsWebSocketVersion
		c.connInfo.Platform = version.Platform
		c.connInfoMux.Unlock()
	}

	// Update connection state
	now := time.Now()
	c.connInfoMux.Lock()
	c.connInfo.ConnectedAt = &now
	c.connInfo.DisconnectedAt = nil
	c.connInfo.ReconnectAttempts = 0
	c.connInfo.LastError = ""
	c.connInfoMux.Unlock()

	c.setState(StateConnected)
	c.logger.WithFields(logrus.Fields{
		"obs_version": c.connInfo.OBSVersion,
		"ws_version":  c.connInfo.WebSocketVersion,
	}).Info("Connected to OBS")

	// Start event listener if auto-reconnect is enabled
	if c.config.AutoReconnect {
		c.wg.Add(1)
		go c.monitorConnection()
	}

	// Emit connected event
	c.emitEvent(Event{
		Type:      EventType("connected"),
		Timestamp: time.Now(),
		Data: map[string]interface{}{
			"obs_version": c.connInfo.OBSVersion,
			"ws_version":  c.connInfo.WebSocketVersion,
		},
	})

	return nil
}

// Disconnect closes the connection to OBS
func (c *Client) Disconnect() error {
	c.stateMux.Lock()
	if c.state == StateDisconnected {
		c.stateMux.Unlock()
		return nil
	}
	c.stateMux.Unlock()

	c.logger.Info("Disconnecting from OBS")

	// Stop reconnection attempts
	select {
	case c.stopReconnect <- struct{}{}:
	default:
	}

	// Close the client
	if c.client != nil {
		if err := c.client.Disconnect(); err != nil {
			c.logger.WithError(err).Warn("Error disconnecting from OBS")
		}
		c.client = nil
	}

	// Update state
	now := time.Now()
	c.connInfoMux.Lock()
	c.connInfo.DisconnectedAt = &now
	c.connInfoMux.Unlock()

	c.setState(StateDisconnected)

	// Emit disconnected event
	c.emitEvent(Event{
		Type:      EventType("disconnected"),
		Timestamp: time.Now(),
		Data: map[string]interface{}{
			"reason": "manual_disconnect",
		},
	})

	return nil
}

// Close shuts down the client completely
func (c *Client) Close() error {
	c.cancel()
	if err := c.Disconnect(); err != nil {
		c.logger.WithError(err).Warn("Error during close disconnect")
	}
	c.wg.Wait()
	return nil
}

// GetState returns the current connection state
func (c *Client) GetState() ConnectionState {
	c.stateMux.RLock()
	defer c.stateMux.RUnlock()
	return c.state
}

// IsConnected returns true if connected to OBS
func (c *Client) IsConnected() bool {
	return c.GetState() == StateConnected
}

// GetConnectionInfo returns detailed connection information
func (c *Client) GetConnectionInfo() ConnectionInfo {
	c.connInfoMux.RLock()
	defer c.connInfoMux.RUnlock()
	info := c.connInfo
	info.State = c.GetState()
	return info
}

// GetClient returns the underlying goobs client (for advanced operations)
func (c *Client) GetClient() *goobs.Client {
	c.stateMux.RLock()
	defer c.stateMux.RUnlock()
	return c.client
}

// Subscribe registers a callback for OBS events
func (c *Client) Subscribe(callback EventCallback, eventTypes ...EventType) SubscriptionID {
	c.callbackMux.Lock()
	defer c.callbackMux.Unlock()

	id := SubscriptionID(uuid.New().String())
	c.eventCallbacks[id] = eventSubscription{
		callback:   callback,
		eventTypes: eventTypes,
	}

	c.logger.WithFields(logrus.Fields{
		"subscription_id": id,
		"event_types":     eventTypes,
	}).Debug("Registered event subscription")

	return id
}

// Unsubscribe removes an event subscription
func (c *Client) Unsubscribe(id SubscriptionID) {
	c.callbackMux.Lock()
	defer c.callbackMux.Unlock()

	if _, exists := c.eventCallbacks[id]; exists {
		delete(c.eventCallbacks, id)
		c.logger.WithField("subscription_id", id).Debug("Removed event subscription")
	}
}

// setState updates the connection state
func (c *Client) setState(state ConnectionState) {
	c.stateMux.Lock()
	oldState := c.state
	c.state = state
	c.stateMux.Unlock()

	c.connInfoMux.Lock()
	c.connInfo.State = state
	c.connInfoMux.Unlock()

	if oldState != state {
		c.logger.WithFields(logrus.Fields{
			"old_state": oldState.String(),
			"new_state": state.String(),
		}).Debug("Connection state changed")
	}
}

// setStateAndError updates the connection state and last error
func (c *Client) setStateAndError(state ConnectionState, errMsg string) {
	c.setState(state)
	c.connInfoMux.Lock()
	c.connInfo.LastError = errMsg
	c.connInfoMux.Unlock()
}

// monitorConnection monitors the connection and triggers reconnection
func (c *Client) monitorConnection() {
	defer c.wg.Done()

	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-c.ctx.Done():
			return
		case <-c.stopReconnect:
			return
		case <-ticker.C:
			if c.GetState() == StateConnected && c.client != nil {
				// Ping to check connection
				_, err := c.client.General.GetVersion()
				if err != nil {
					c.logger.WithError(err).Warn("Connection lost, attempting reconnect")
					c.handleDisconnect()
				}
			}
		}
	}
}

// handleDisconnect handles unexpected disconnection
func (c *Client) handleDisconnect() {
	now := time.Now()
	c.connInfoMux.Lock()
	c.connInfo.DisconnectedAt = &now
	c.connInfoMux.Unlock()

	c.setState(StateReconnecting)

	// Emit disconnected event
	c.emitEvent(Event{
		Type:      EventType("disconnected"),
		Timestamp: time.Now(),
		Data: map[string]interface{}{
			"reason": "connection_lost",
		},
	})

	// Start reconnection attempts
	go c.attemptReconnect()
}

// attemptReconnect tries to reconnect with exponential backoff
func (c *Client) attemptReconnect() {
	interval := c.config.ReconnectInterval
	attempts := 0

	for {
		select {
		case <-c.ctx.Done():
			return
		case <-c.stopReconnect:
			return
		default:
		}

		attempts++
		c.connInfoMux.Lock()
		c.connInfo.ReconnectAttempts = attempts
		c.connInfoMux.Unlock()

		c.logger.WithFields(logrus.Fields{
			"attempt":  attempts,
			"interval": interval,
		}).Info("Attempting to reconnect to OBS")

		// Try to connect
		ctx, cancel := context.WithTimeout(c.ctx, c.config.Timeout)
		err := c.Connect(ctx)
		cancel()

		if err == nil {
			c.logger.Info("Reconnected to OBS successfully")
			c.emitEvent(Event{
				Type:      EventType("reconnected"),
				Timestamp: time.Now(),
				Data: map[string]interface{}{
					"attempts": attempts,
				},
			})
			return
		}

		c.logger.WithError(err).WithField("attempt", attempts).Warn("Reconnection failed")

		// Wait before next attempt with exponential backoff
		select {
		case <-c.ctx.Done():
			return
		case <-c.stopReconnect:
			return
		case <-time.After(interval):
		}

		// Exponential backoff
		interval = interval * 2
		if interval > c.config.MaxReconnectInterval {
			interval = c.config.MaxReconnectInterval
		}
	}
}

// emitEvent sends an event to all registered callbacks
func (c *Client) emitEvent(event Event) {
	c.callbackMux.RLock()
	defer c.callbackMux.RUnlock()

	for _, sub := range c.eventCallbacks {
		// Check if subscription is for all events or specific event types
		if len(sub.eventTypes) == 0 {
			go sub.callback(event)
		} else {
			for _, et := range sub.eventTypes {
				if et == event.Type {
					go sub.callback(event)
					break
				}
			}
		}
	}
}

// GetStats returns current OBS statistics
func (c *Client) GetStats(ctx context.Context) (*OBSStats, error) {
	if !c.IsConnected() {
		return nil, ErrNotConnected
	}

	stats, err := c.client.General.GetStats()
	if err != nil {
		return nil, NewOBSError(ErrOperationFailed, err.Error())
	}

	return &OBSStats{
		CPUUsage:                         stats.CpuUsage,
		MemoryUsage:                      stats.MemoryUsage,
		FreeDiskSpace:                    stats.AvailableDiskSpace,
		ActiveFPS:                        stats.ActiveFps,
		AverageFrameTime:                 stats.AverageFrameRenderTime,
		RenderSkippedFrames:              int64(stats.RenderSkippedFrames),
		RenderTotalFrames:                int64(stats.RenderTotalFrames),
		OutputSkippedFrames:              int64(stats.OutputSkippedFrames),
		OutputTotalFrames:                int64(stats.OutputTotalFrames),
		WebSocketSessionIncomingMessages: int64(stats.WebSocketSessionIncomingMessages),
		WebSocketSessionOutgoingMessages: int64(stats.WebSocketSessionOutgoingMessages),
	}, nil
}
