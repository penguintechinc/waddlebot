package external

import (
	"github.com/sirupsen/logrus"

	"waddlebot-bridge/internal/config"
)

// BashEngine implements ScriptEngine for Bash
type BashEngine struct {
	*BaseEngine
}

// NewBashEngine creates a new Bash engine
func NewBashEngine(cfg config.ScriptingConfig, logger *logrus.Logger) *BashEngine {
	executable := cfg.BashPath
	if executable == "" {
		executable = "bash"
	}

	return &BashEngine{
		BaseEngine: &BaseEngine{
			config:     cfg,
			logger:     logger,
			scriptType: "bash",
			executable: executable,
			args:       []string{"-s"}, // Read from stdin
			fileExt:    ".sh",
		},
	}
}
