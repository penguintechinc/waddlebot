package lua

import (
	"time"

	lua "github.com/yuin/gopher-lua"
)

// loadWaddleBotAPI loads WaddleBot-specific API functions into Lua
func (e *Engine) loadWaddleBotAPI(L *lua.LState) {
	// Create log module
	logModule := L.NewTable()
	L.SetFuncs(logModule, map[string]lua.LGFunction{
		"info":  e.luaLogInfo,
		"warn":  e.luaLogWarn,
		"error": e.luaLogError,
		"debug": e.luaLogDebug,
	})
	L.SetGlobal("log", logModule)

	// Create storage module (simple key-value)
	storageModule := L.NewTable()
	L.SetFuncs(storageModule, map[string]lua.LGFunction{
		"get": e.luaStorageGet,
		"set": e.luaStorageSet,
	})
	L.SetGlobal("storage", storageModule)

	// Create utility functions
	L.SetGlobal("sleep", L.NewFunction(e.luaSleep))
	L.SetGlobal("time", L.NewFunction(e.luaTime))

	// Create OBS module (if available)
	obsModule := L.NewTable()
	L.SetFuncs(obsModule, map[string]lua.LGFunction{
		"connect":            e.luaOBSConnect,
		"switch_scene":       e.luaOBSSwitchScene,
		"set_source_visible": e.luaOBSSetSourceVisible,
		"start_stream":       e.luaOBSStartStream,
		"stop_stream":        e.luaOBSStopStream,
		"start_recording":    e.luaOBSStartRecording,
		"stop_recording":     e.luaOBSStopRecording,
	})
	L.SetGlobal("obs", obsModule)

	// Create bridge module
	bridgeModule := L.NewTable()
	L.SetFuncs(bridgeModule, map[string]lua.LGFunction{
		"send_response": e.luaBridgeSendResponse,
		"trigger":       e.luaBridgeTrigger,
	})
	L.SetGlobal("bridge", bridgeModule)
}

// Logging functions

func (e *Engine) luaLogInfo(L *lua.LState) int {
	msg := L.ToString(1)
	e.logger.Info("[Lua] " + msg)
	return 0
}

func (e *Engine) luaLogWarn(L *lua.LState) int {
	msg := L.ToString(1)
	e.logger.Warn("[Lua] " + msg)
	return 0
}

func (e *Engine) luaLogError(L *lua.LState) int {
	msg := L.ToString(1)
	e.logger.Error("[Lua] " + msg)
	return 0
}

func (e *Engine) luaLogDebug(L *lua.LState) int {
	msg := L.ToString(1)
	e.logger.Debug("[Lua] " + msg)
	return 0
}

// Storage functions (in-memory for now)

var scriptStorage = make(map[string]string)

func (e *Engine) luaStorageGet(L *lua.LState) int {
	key := L.ToString(1)
	value, exists := scriptStorage[key]
	if !exists {
		L.Push(lua.LNil)
		return 1
	}
	L.Push(lua.LString(value))
	return 1
}

func (e *Engine) luaStorageSet(L *lua.LState) int {
	key := L.ToString(1)
	value := L.ToString(2)
	scriptStorage[key] = value
	return 0
}

// Utility functions

func (e *Engine) luaSleep(L *lua.LState) int {
	ms := L.ToInt(1)
	time.Sleep(time.Duration(ms) * time.Millisecond)
	return 0
}

func (e *Engine) luaTime(L *lua.LState) int {
	L.Push(lua.LNumber(time.Now().Unix()))
	return 1
}

// OBS functions (stubs - will be connected to actual OBS client)

func (e *Engine) luaOBSConnect(L *lua.LState) int {
	// TODO: Connect to OBS client
	e.logger.Debug("[Lua] OBS connect called")
	L.Push(lua.LBool(true))
	return 1
}

func (e *Engine) luaOBSSwitchScene(L *lua.LState) int {
	sceneName := L.ToString(1)
	// TODO: Call OBS client
	e.logger.WithField("scene", sceneName).Debug("[Lua] OBS switch scene called")
	L.Push(lua.LBool(true))
	return 1
}

func (e *Engine) luaOBSSetSourceVisible(L *lua.LState) int {
	sceneName := L.ToString(1)
	sourceName := L.ToString(2)
	visible := L.ToBool(3)
	// TODO: Call OBS client
	e.logger.WithField("scene", sceneName).
		WithField("source", sourceName).
		WithField("visible", visible).
		Debug("[Lua] OBS set source visible called")
	L.Push(lua.LBool(true))
	return 1
}

func (e *Engine) luaOBSStartStream(L *lua.LState) int {
	// TODO: Call OBS client
	e.logger.Debug("[Lua] OBS start stream called")
	L.Push(lua.LBool(true))
	return 1
}

func (e *Engine) luaOBSStopStream(L *lua.LState) int {
	// TODO: Call OBS client
	e.logger.Debug("[Lua] OBS stop stream called")
	L.Push(lua.LBool(true))
	return 1
}

func (e *Engine) luaOBSStartRecording(L *lua.LState) int {
	// TODO: Call OBS client
	e.logger.Debug("[Lua] OBS start recording called")
	L.Push(lua.LBool(true))
	return 1
}

func (e *Engine) luaOBSStopRecording(L *lua.LState) int {
	// TODO: Call OBS client
	e.logger.Debug("[Lua] OBS stop recording called")
	L.Push(lua.LBool(true))
	return 1
}

// Bridge functions (stubs - will be connected to bridge client)

func (e *Engine) luaBridgeSendResponse(L *lua.LState) int {
	data := L.ToString(1)
	// TODO: Send via bridge client
	e.logger.WithField("data", data).Debug("[Lua] Bridge send response called")
	L.Push(lua.LBool(true))
	return 1
}

func (e *Engine) luaBridgeTrigger(L *lua.LState) int {
	module := L.ToString(1)
	action := L.ToString(2)
	params := L.ToString(3)
	// TODO: Trigger via bridge client
	e.logger.WithField("module", module).
		WithField("action", action).
		WithField("params", params).
		Debug("[Lua] Bridge trigger called")
	L.Push(lua.LBool(true))
	return 1
}
