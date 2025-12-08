package scripting

import (
	"waddlebot-bridge/internal/scripting/common"
)

// Re-export types from common to maintain API
type (
	ScriptType   = common.ScriptType
	ScriptConfig = common.ScriptConfig
	ScriptResult = common.ScriptResult
	ScriptEngine = common.ScriptEngine
)

// Re-export constants
const (
	ScriptTypeLua        = common.ScriptTypeLua
	ScriptTypePython     = common.ScriptTypePython
	ScriptTypePowerShell = common.ScriptTypePowerShell
	ScriptTypeBash       = common.ScriptTypeBash
)
