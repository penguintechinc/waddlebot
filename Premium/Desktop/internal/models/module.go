package models

import "time"

// ModuleInfo represents information about a module.
type ModuleInfo struct {
	Name         string            `json:"name"`
	Version      string            `json:"version"`
	Description  string            `json:"description"`
	Author       string            `json:"author"`
	Actions      []ActionInfo      `json:"actions"`
	Dependencies []string          `json:"dependencies"`
	Permissions  []string          `json:"permissions"`
	Config       map[string]string `json:"config"`
	Enabled      bool              `json:"enabled"`
	LoadedAt     time.Time         `json:"loaded_at"`
	LastUsed     time.Time         `json:"last_used"`
}

// ActionInfo represents information about an action.
type ActionInfo struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	Parameters  map[string]interface{} `json:"parameters"`
	ReturnType  string                 `json:"return_type"`
	Timeout     int                    `json:"timeout"`
	Permissions []string               `json:"permissions"`
}
