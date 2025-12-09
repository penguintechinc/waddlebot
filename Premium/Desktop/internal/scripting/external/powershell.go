package external

import (
	"github.com/sirupsen/logrus"

	"waddlebot-bridge/internal/config"
)

// PowerShellEngine implements ScriptEngine for PowerShell
type PowerShellEngine struct {
	*BaseEngine
}

// NewPowerShellEngine creates a new PowerShell engine
func NewPowerShellEngine(cfg config.ScriptingConfig, logger *logrus.Logger) *PowerShellEngine {
	executable := cfg.PowerShellPath
	if executable == "" {
		executable = "pwsh" // PowerShell Core
	}

	return &PowerShellEngine{
		BaseEngine: &BaseEngine{
			config:     cfg,
			logger:     logger,
			scriptType: "powershell",
			executable: executable,
			args: []string{
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"-",
			},
			fileExt: ".ps1",
		},
	}
}
