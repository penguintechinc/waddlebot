package external

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"time"

	"github.com/sirupsen/logrus"

	"waddlebot-bridge/internal/config"
	"waddlebot-bridge/internal/scripting/common"
)

// BaseEngine provides common functionality for external script engines
type BaseEngine struct {
	config      config.ScriptingConfig
	logger      *logrus.Logger
	scriptType  string
	executable  string
	args        []string
	fileExt     string
}

// Execute executes an external script
func (e *BaseEngine) Execute(ctx context.Context, config common.ScriptConfig) (*common.ScriptResult, error) {
	start := time.Now()

	// Set timeout
	timeout := config.Timeout
	if timeout == 0 {
		timeout = time.Duration(e.config.DefaultTimeout) * time.Second
	}

	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	// Build command
	cmd := exec.CommandContext(ctx, e.executable, e.args...)

	// Set up environment
	if config.Environment != nil {
		env := make([]string, 0, len(config.Environment))
		for k, v := range config.Environment {
			env = append(env, fmt.Sprintf("%s=%s", k, v))
		}
		cmd.Env = env
	}

	// Capture output
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	// Pass script via stdin
	cmd.Stdin = bytes.NewBufferString(config.Source)

	// Execute
	err := cmd.Run()

	result := &common.ScriptResult{
		Output:   stdout.String(),
		Error:    stderr.String(),
		Duration: time.Since(start),
	}

	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			result.ExitCode = exitErr.ExitCode()
		} else {
			result.ExitCode = 1
		}
		return result, err
	}

	result.ExitCode = 0
	return result, nil
}

// Validate validates an external script
func (e *BaseEngine) Validate(config common.ScriptConfig) error {
	if config.Source == "" {
		return fmt.Errorf("script source is empty")
	}

	// Check if executable exists
	if _, err := exec.LookPath(e.executable); err != nil {
		return fmt.Errorf("executable %s not found: %w", e.executable, err)
	}

	return nil
}

// GetType returns the engine type
func (e *BaseEngine) GetType() common.ScriptType {
	return common.ScriptType(e.scriptType)
}
