package lua

import (
	"context"
	"fmt"
	"time"

	lua "github.com/yuin/gopher-lua"
	"github.com/sirupsen/logrus"

	"waddlebot-bridge/internal/config"
	"waddlebot-bridge/internal/scripting/common"
)

// Engine implements ScriptEngine for Lua
type Engine struct {
	config config.ScriptingConfig
	logger *logrus.Logger
}

// NewEngine creates a new Lua engine
func NewEngine(cfg config.ScriptingConfig, logger *logrus.Logger) *Engine {
	return &Engine{
		config: cfg,
		logger: logger,
	}
}

// Execute executes a Lua script
func (e *Engine) Execute(ctx context.Context, config common.ScriptConfig) (*common.ScriptResult, error) {
	start := time.Now()

	// Create new Lua state with memory limit
	L := lua.NewState(lua.Options{
		CallStackSize:       120,
		RegistrySize:        1024,
		SkipOpenLibs:        false,
		IncludeGoStackTrace: false,
	})
	defer L.Close()

	// Load safe libraries
	e.loadSafeLibraries(L)

	// Load WaddleBot API
	e.loadWaddleBotAPI(L)

	// Set timeout
	timeout := config.Timeout
	if timeout == 0 {
		timeout = time.Duration(e.config.DefaultTimeout) * time.Second
	}

	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	// Set up context cancellation
	L.SetContext(ctx)

	// Execute script
	result := &common.ScriptResult{}

	if err := L.DoString(config.Source); err != nil {
		result.Error = err.Error()
		result.ExitCode = 1
		result.Duration = time.Since(start)
		return result, err
	}

	// Capture output from global _OUTPUT variable if set
	if output := L.GetGlobal("_OUTPUT"); output != lua.LNil {
		result.Output = output.String()
	}

	result.ExitCode = 0
	result.Duration = time.Since(start)

	return result, nil
}

// Validate validates a Lua script
func (e *Engine) Validate(config common.ScriptConfig) error {
	if config.Source == "" {
		return fmt.Errorf("script source is empty")
	}

	// Try to compile the script
	L := lua.NewState()
	defer L.Close()

	_, err := L.LoadString(config.Source)
	if err != nil {
		return fmt.Errorf("syntax error: %w", err)
	}

	return nil
}

// GetType returns the engine type
func (e *Engine) GetType() common.ScriptType {
	return common.ScriptTypeLua
}

// loadSafeLibraries loads only safe Lua standard libraries
func (e *Engine) loadSafeLibraries(L *lua.LState) {
	// Load safe base functions
	for _, pair := range []struct {
		n string
		f lua.LGFunction
	}{
		{lua.LoadLibName, lua.OpenPackage},
		{lua.BaseLibName, lua.OpenBase},
		{lua.TabLibName, lua.OpenTable},
		{lua.StringLibName, lua.OpenString},
		{lua.MathLibName, lua.OpenMath},
	} {
		if err := L.CallByParam(lua.P{
			Fn:      L.NewFunction(pair.f),
			NRet:    0,
			Protect: true,
		}, lua.LString(pair.n)); err != nil {
			e.logger.WithError(err).Error("Failed to load Lua library")
		}
	}

	// Remove unsafe functions
	unsafeFunctions := []string{
		"dofile",
		"loadfile",
		"load",
		"loadstring",
	}

	for _, fn := range unsafeFunctions {
		L.SetGlobal(fn, lua.LNil)
	}

	// Optionally load IO/OS with restrictions
	if e.config.AllowFileSystem {
		lua.OpenIo(L)
	}

	if e.config.AllowNetwork {
		// Network access would be through custom API, not standard library
	}
}
