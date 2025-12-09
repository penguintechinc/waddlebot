package common

import (
	"context"
	"time"
)

// ScriptType represents the type of script
type ScriptType string

const (
	ScriptTypeLua        ScriptType = "lua"
	ScriptTypePython     ScriptType = "python"
	ScriptTypePowerShell ScriptType = "powershell"
	ScriptTypeBash       ScriptType = "bash"
)

// ScriptConfig represents configuration for script execution
type ScriptConfig struct {
	Type            ScriptType
	Source          string
	Timeout         time.Duration
	MaxMemoryMB     int
	AllowNetwork    bool
	AllowFileSystem bool
	Environment     map[string]string
}

// ScriptResult represents the result of script execution
type ScriptResult struct {
	Output   string
	Error    string
	ExitCode int
	Duration time.Duration
}

// ScriptEngine defines the interface for script execution
type ScriptEngine interface {
	Execute(ctx context.Context, config ScriptConfig) (*ScriptResult, error)
	Validate(config ScriptConfig) error
	GetType() ScriptType
}
