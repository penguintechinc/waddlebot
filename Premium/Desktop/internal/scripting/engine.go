package scripting

import (
	"context"
	"fmt"
	"sync"

	"github.com/sirupsen/logrus"

	"waddlebot-bridge/internal/config"
	"waddlebot-bridge/internal/scripting/external"
	"waddlebot-bridge/internal/scripting/lua"
)

// Manager manages script execution across different engines
type Manager struct {
	config  config.ScriptingConfig
	engines map[ScriptType]ScriptEngine
	logger  *logrus.Logger
	mu      sync.RWMutex
}

// NewManager creates a new script manager
func NewManager(cfg config.ScriptingConfig, logger *logrus.Logger) (*Manager, error) {
	m := &Manager{
		config:  cfg,
		engines: make(map[ScriptType]ScriptEngine),
		logger:  logger,
	}

	// Initialize Lua engine if enabled
	if cfg.EnableLua {
		luaEngine := lua.NewEngine(cfg, logger)
		m.engines[ScriptTypeLua] = luaEngine
		logger.Info("Lua scripting engine enabled")
	}

	// Initialize Python engine if enabled
	if cfg.EnablePython {
		pythonEngine := external.NewPythonEngine(cfg, logger)
		m.engines[ScriptTypePython] = pythonEngine
		logger.Info("Python scripting engine enabled")
	}

	// Initialize PowerShell engine if enabled
	if cfg.EnablePowerShell {
		psEngine := external.NewPowerShellEngine(cfg, logger)
		m.engines[ScriptTypePowerShell] = psEngine
		logger.Info("PowerShell scripting engine enabled")
	}

	// Initialize Bash engine if enabled
	if cfg.EnableBash {
		bashEngine := external.NewBashEngine(cfg, logger)
		m.engines[ScriptTypeBash] = bashEngine
		logger.Info("Bash scripting engine enabled")
	}

	if len(m.engines) == 0 {
		return nil, fmt.Errorf("no scripting engines enabled")
	}

	return m, nil
}

// Execute executes a script with the appropriate engine
func (m *Manager) Execute(ctx context.Context, config ScriptConfig) (*ScriptResult, error) {
	m.mu.RLock()
	engine, exists := m.engines[config.Type]
	m.mu.RUnlock()

	if !exists {
		return nil, fmt.Errorf("script type %s not enabled", config.Type)
	}

	// Validate script before execution
	if err := engine.Validate(config); err != nil {
		return nil, fmt.Errorf("script validation failed: %w", err)
	}

	// Execute script
	result, err := engine.Execute(ctx, config)
	if err != nil {
		m.logger.WithFields(logrus.Fields{
			"type":  config.Type,
			"error": err.Error(),
		}).Error("Script execution failed")
		return nil, err
	}

	m.logger.WithFields(logrus.Fields{
		"type":      config.Type,
		"duration":  result.Duration,
		"exit_code": result.ExitCode,
	}).Info("Script executed successfully")

	return result, nil
}

// Validate validates a script configuration
func (m *Manager) Validate(config ScriptConfig) error {
	m.mu.RLock()
	engine, exists := m.engines[config.Type]
	m.mu.RUnlock()

	if !exists {
		return fmt.Errorf("script type %s not enabled", config.Type)
	}

	return engine.Validate(config)
}

// GetEnabledTypes returns the list of enabled script types
func (m *Manager) GetEnabledTypes() []ScriptType {
	m.mu.RLock()
	defer m.mu.RUnlock()

	types := make([]ScriptType, 0, len(m.engines))
	for t := range m.engines {
		types = append(types, t)
	}

	return types
}

// IsTypeEnabled checks if a script type is enabled
func (m *Manager) IsTypeEnabled(scriptType ScriptType) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()

	_, exists := m.engines[scriptType]
	return exists
}
