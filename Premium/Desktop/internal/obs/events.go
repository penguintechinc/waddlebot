package obs

import (
	"time"

	"github.com/andreykaipov/goobs/api/events"
)

// StartEventListener starts listening for OBS events
// This should be called after a successful connection
func (c *Client) StartEventListener() error {
	if !c.IsConnected() {
		return ErrNotConnected
	}

	// Subscribe to all event categories using a callback
	c.client.Listen(func(event any) {
		c.handleOBSEvent(event)
	})

	c.logger.Info("Started OBS event listener")
	return nil
}


// handleOBSEvent converts goobs events to our Event type and dispatches them
func (c *Client) handleOBSEvent(event interface{}) {
	var ev Event
	ev.Timestamp = time.Now()
	ev.Data = make(map[string]interface{})

	switch e := event.(type) {
	// Scene events
	case *events.CurrentProgramSceneChanged:
		ev.Type = EventSceneChanged
		ev.Data["scene_name"] = e.SceneName
	case *events.SceneListChanged:
		ev.Type = EventSceneListChanged
		ev.Data["scenes"] = e.Scenes
	case *events.SceneNameChanged:
		ev.Type = EventSceneNameChanged
		ev.Data["old_name"] = e.OldSceneName
		ev.Data["new_name"] = e.SceneName
	case *events.SceneCreated:
		ev.Type = EventSceneCreated
		ev.Data["scene_name"] = e.SceneName
		ev.Data["is_group"] = e.IsGroup
	case *events.SceneRemoved:
		ev.Type = EventSceneRemoved
		ev.Data["scene_name"] = e.SceneName
		ev.Data["is_group"] = e.IsGroup

	// Source/Scene item events
	case *events.SceneItemEnableStateChanged:
		ev.Type = EventSourceVisibilityChanged
		ev.Data["scene_name"] = e.SceneName
		ev.Data["item_id"] = e.SceneItemId
		ev.Data["enabled"] = e.SceneItemEnabled
	case *events.SceneItemLockStateChanged:
		ev.Type = EventSourceLockChanged
		ev.Data["scene_name"] = e.SceneName
		ev.Data["item_id"] = e.SceneItemId
		ev.Data["locked"] = e.SceneItemLocked
	case *events.SceneItemTransformChanged:
		ev.Type = EventSourceTransformChanged
		ev.Data["scene_name"] = e.SceneName
		ev.Data["item_id"] = e.SceneItemId
		ev.Data["transform"] = e.SceneItemTransform
	case *events.SceneItemCreated:
		ev.Type = EventSourceCreated
		ev.Data["scene_name"] = e.SceneName
		ev.Data["source_name"] = e.SourceName
		ev.Data["item_id"] = e.SceneItemId
	case *events.SceneItemRemoved:
		ev.Type = EventSourceRemoved
		ev.Data["scene_name"] = e.SceneName
		ev.Data["source_name"] = e.SourceName
		ev.Data["item_id"] = e.SceneItemId
	case *events.InputNameChanged:
		ev.Type = EventSourceRenamed
		ev.Data["old_name"] = e.OldInputName
		ev.Data["new_name"] = e.InputName

	// Filter events
	case *events.SourceFilterEnableStateChanged:
		if e.FilterEnabled {
			ev.Type = EventFilterEnabled
		} else {
			ev.Type = EventFilterDisabled
		}
		ev.Data["source_name"] = e.SourceName
		ev.Data["filter_name"] = e.FilterName
		ev.Data["enabled"] = e.FilterEnabled
	case *events.SourceFilterListReindexed:
		ev.Type = EventFilterListChanged
		ev.Data["source_name"] = e.SourceName
		ev.Data["filters"] = e.Filters
	case *events.SourceFilterNameChanged:
		ev.Type = EventFilterNameChanged
		ev.Data["source_name"] = e.SourceName
		ev.Data["old_name"] = e.OldFilterName
		ev.Data["new_name"] = e.FilterName
	case *events.SourceFilterCreated:
		ev.Type = EventFilterCreated
		ev.Data["source_name"] = e.SourceName
		ev.Data["filter_name"] = e.FilterName
		ev.Data["filter_kind"] = e.FilterKind
	case *events.SourceFilterRemoved:
		ev.Type = EventFilterRemoved
		ev.Data["source_name"] = e.SourceName
		ev.Data["filter_name"] = e.FilterName

	// Stream events
	case *events.StreamStateChanged:
		if e.OutputActive {
			ev.Type = EventStreamStarted
		} else {
			ev.Type = EventStreamStopped
		}
		ev.Data["active"] = e.OutputActive
		ev.Data["state"] = e.OutputState

	// Recording events
	case *events.RecordStateChanged:
		switch e.OutputState {
		case "OBS_WEBSOCKET_OUTPUT_STARTING":
			ev.Type = EventRecordingStarting
		case "OBS_WEBSOCKET_OUTPUT_STARTED":
			ev.Type = EventRecordingStarted
		case "OBS_WEBSOCKET_OUTPUT_STOPPING":
			ev.Type = EventRecordingStopping
		case "OBS_WEBSOCKET_OUTPUT_STOPPED":
			ev.Type = EventRecordingStopped
		case "OBS_WEBSOCKET_OUTPUT_PAUSED":
			ev.Type = EventRecordingPaused
		case "OBS_WEBSOCKET_OUTPUT_RESUMED":
			ev.Type = EventRecordingResumed
		default:
			return // Unknown state, skip
		}
		ev.Data["active"] = e.OutputActive
		ev.Data["state"] = e.OutputState
		ev.Data["output_path"] = e.OutputPath

	// General events
	case *events.ExitStarted:
		ev.Type = EventExiting
	case *events.StudioModeStateChanged:
		ev.Type = EventStudioModeChanged
		ev.Data["enabled"] = e.StudioModeEnabled

	default:
		// Unknown event type, skip
		return
	}

	c.emitEvent(ev)
}

// GetAvailableEventTypes returns all supported event types
func GetAvailableEventTypes() []EventType {
	return []EventType{
		// Scene events
		EventSceneChanged,
		EventSceneListChanged,
		EventSceneNameChanged,
		EventSceneCreated,
		EventSceneRemoved,

		// Source events
		EventSourceVisibilityChanged,
		EventSourceLockChanged,
		EventSourceTransformChanged,
		EventSourceCreated,
		EventSourceRemoved,
		EventSourceRenamed,

		// Filter events
		EventFilterEnabled,
		EventFilterDisabled,
		EventFilterListChanged,
		EventFilterNameChanged,
		EventFilterCreated,
		EventFilterRemoved,

		// Streaming events
		EventStreamStarting,
		EventStreamStarted,
		EventStreamStopping,
		EventStreamStopped,
		EventStreamReconnect,

		// Recording events
		EventRecordingStarting,
		EventRecordingStarted,
		EventRecordingStopping,
		EventRecordingStopped,
		EventRecordingPaused,
		EventRecordingResumed,

		// General events
		EventExiting,
		EventStudioModeChanged,
	}
}

// SubscribeAll subscribes to all OBS events
func (c *Client) SubscribeAll(callback EventCallback) SubscriptionID {
	return c.Subscribe(callback)
}

// SubscribeSceneEvents subscribes to scene-related events
func (c *Client) SubscribeSceneEvents(callback EventCallback) SubscriptionID {
	return c.Subscribe(callback,
		EventSceneChanged,
		EventSceneListChanged,
		EventSceneNameChanged,
		EventSceneCreated,
		EventSceneRemoved,
	)
}

// SubscribeSourceEvents subscribes to source-related events
func (c *Client) SubscribeSourceEvents(callback EventCallback) SubscriptionID {
	return c.Subscribe(callback,
		EventSourceVisibilityChanged,
		EventSourceLockChanged,
		EventSourceTransformChanged,
		EventSourceCreated,
		EventSourceRemoved,
		EventSourceRenamed,
	)
}

// SubscribeFilterEvents subscribes to filter-related events
func (c *Client) SubscribeFilterEvents(callback EventCallback) SubscriptionID {
	return c.Subscribe(callback,
		EventFilterEnabled,
		EventFilterDisabled,
		EventFilterListChanged,
		EventFilterNameChanged,
		EventFilterCreated,
		EventFilterRemoved,
	)
}

// SubscribeStreamEvents subscribes to streaming-related events
func (c *Client) SubscribeStreamEvents(callback EventCallback) SubscriptionID {
	return c.Subscribe(callback,
		EventStreamStarting,
		EventStreamStarted,
		EventStreamStopping,
		EventStreamStopped,
		EventStreamReconnect,
	)
}

// SubscribeRecordingEvents subscribes to recording-related events
func (c *Client) SubscribeRecordingEvents(callback EventCallback) SubscriptionID {
	return c.Subscribe(callback,
		EventRecordingStarting,
		EventRecordingStarted,
		EventRecordingStopping,
		EventRecordingStopped,
		EventRecordingPaused,
		EventRecordingResumed,
	)
}
