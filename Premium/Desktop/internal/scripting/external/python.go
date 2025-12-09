package external

import (
	"github.com/sirupsen/logrus"

	"waddlebot-bridge/internal/config"
)

// PythonEngine implements ScriptEngine for Python
type PythonEngine struct {
	*BaseEngine
}

// NewPythonEngine creates a new Python engine
func NewPythonEngine(cfg config.ScriptingConfig, logger *logrus.Logger) *PythonEngine {
	executable := cfg.PythonPath
	if executable == "" {
		executable = "python3"
	}

	return &PythonEngine{
		BaseEngine: &BaseEngine{
			config:     cfg,
			logger:     logger,
			scriptType: "python",
			executable: executable,
			args:       []string{"-u"}, // Unbuffered output
			fileExt:    ".py",
		},
	}
}
