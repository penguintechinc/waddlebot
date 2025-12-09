package obs

import (
	"context"

	"github.com/andreykaipov/goobs/api/requests/scenes"
	"github.com/andreykaipov/goobs/api/requests/ui"
)

// GetScenes returns the list of all scenes
func (c *Client) GetScenes(ctx context.Context) ([]SceneInfo, error) {
	if !c.IsConnected() {
		return nil, ErrNotConnected
	}

	// Get scene list
	resp, err := c.client.Scenes.GetSceneList()
	if err != nil {
		return nil, NewOBSError(ErrOperationFailed, err.Error())
	}

	scenes := make([]SceneInfo, len(resp.Scenes))
	for i, s := range resp.Scenes {
		scenes[i] = SceneInfo{
			Name:      s.SceneName,
			Index:     i,
			IsCurrent: s.SceneName == resp.CurrentProgramSceneName,
			IsPreview: s.SceneName == resp.CurrentPreviewSceneName,
		}
	}

	return scenes, nil
}

// GetCurrentScene returns the current program scene
func (c *Client) GetCurrentScene(ctx context.Context) (*SceneInfo, error) {
	if !c.IsConnected() {
		return nil, ErrNotConnected
	}

	resp, err := c.client.Scenes.GetCurrentProgramScene()
	if err != nil {
		return nil, NewOBSError(ErrOperationFailed, err.Error())
	}

	return &SceneInfo{
		Name:      resp.CurrentProgramSceneName,
		IsCurrent: true,
	}, nil
}

// GetPreviewScene returns the current preview scene (studio mode only)
func (c *Client) GetPreviewScene(ctx context.Context) (*SceneInfo, error) {
	if !c.IsConnected() {
		return nil, ErrNotConnected
	}

	resp, err := c.client.Scenes.GetCurrentPreviewScene()
	if err != nil {
		return nil, NewOBSError(ErrOperationFailed, err.Error())
	}

	return &SceneInfo{
		Name:      resp.CurrentPreviewSceneName,
		IsPreview: true,
	}, nil
}

// SetCurrentScene switches to the specified scene
func (c *Client) SetCurrentScene(ctx context.Context, sceneName string) error {
	if !c.IsConnected() {
		return ErrNotConnected
	}

	_, err := c.client.Scenes.SetCurrentProgramScene(&scenes.SetCurrentProgramSceneParams{
		SceneName: &sceneName,
	})
	if err != nil {
		return NewOBSError(ErrOperationFailed, err.Error())
	}

	c.logger.WithField("scene", sceneName).Info("Switched to scene")
	return nil
}

// SetPreviewScene sets the preview scene (studio mode only)
func (c *Client) SetPreviewScene(ctx context.Context, sceneName string) error {
	if !c.IsConnected() {
		return ErrNotConnected
	}

	_, err := c.client.Scenes.SetCurrentPreviewScene(&scenes.SetCurrentPreviewSceneParams{
		SceneName: &sceneName,
	})
	if err != nil {
		return NewOBSError(ErrOperationFailed, err.Error())
	}

	c.logger.WithField("scene", sceneName).Info("Set preview scene")
	return nil
}

// CreateScene creates a new scene
func (c *Client) CreateScene(ctx context.Context, sceneName string) error {
	if !c.IsConnected() {
		return ErrNotConnected
	}

	_, err := c.client.Scenes.CreateScene(&scenes.CreateSceneParams{
		SceneName: &sceneName,
	})
	if err != nil {
		return NewOBSError(ErrOperationFailed, err.Error())
	}

	c.logger.WithField("scene", sceneName).Info("Created scene")
	return nil
}

// RemoveScene removes a scene
func (c *Client) RemoveScene(ctx context.Context, sceneName string) error {
	if !c.IsConnected() {
		return ErrNotConnected
	}

	_, err := c.client.Scenes.RemoveScene(&scenes.RemoveSceneParams{
		SceneName: &sceneName,
	})
	if err != nil {
		return NewOBSError(ErrOperationFailed, err.Error())
	}

	c.logger.WithField("scene", sceneName).Info("Removed scene")
	return nil
}

// RenameScene renames a scene
func (c *Client) RenameScene(ctx context.Context, oldName, newName string) error {
	if !c.IsConnected() {
		return ErrNotConnected
	}

	_, err := c.client.Scenes.SetSceneName(&scenes.SetSceneNameParams{
		SceneName:    &oldName,
		NewSceneName: &newName,
	})
	if err != nil {
		return NewOBSError(ErrOperationFailed, err.Error())
	}

	c.logger.WithFields(map[string]interface{}{
		"old_name": oldName,
		"new_name": newName,
	}).Info("Renamed scene")
	return nil
}

// GetStudioModeEnabled checks if studio mode is enabled
func (c *Client) GetStudioModeEnabled(ctx context.Context) (bool, error) {
	if !c.IsConnected() {
		return false, ErrNotConnected
	}

	resp, err := c.client.Ui.GetStudioModeEnabled()
	if err != nil {
		return false, NewOBSError(ErrOperationFailed, err.Error())
	}

	return resp.StudioModeEnabled, nil
}

// SetStudioModeEnabled enables or disables studio mode
func (c *Client) SetStudioModeEnabled(ctx context.Context, enabled bool) error {
	if !c.IsConnected() {
		return ErrNotConnected
	}

	_, err := c.client.Ui.SetStudioModeEnabled(&ui.SetStudioModeEnabledParams{
		StudioModeEnabled: &enabled,
	})
	if err != nil {
		return NewOBSError(ErrOperationFailed, err.Error())
	}

	c.logger.WithField("enabled", enabled).Info("Set studio mode")
	return nil
}

// TriggerStudioModeTransition triggers the transition in studio mode
func (c *Client) TriggerStudioModeTransition(ctx context.Context) error {
	if !c.IsConnected() {
		return ErrNotConnected
	}

	_, err := c.client.Transitions.TriggerStudioModeTransition()
	if err != nil {
		return NewOBSError(ErrOperationFailed, err.Error())
	}

	c.logger.Info("Triggered studio mode transition")
	return nil
}

// GetSceneWithSources returns a scene with its sources populated
func (c *Client) GetSceneWithSources(ctx context.Context, sceneName string) (*SceneInfo, error) {
	if !c.IsConnected() {
		return nil, ErrNotConnected
	}

	// Get scene list to find scene info
	scenes, err := c.GetScenes(ctx)
	if err != nil {
		return nil, err
	}

	var scene *SceneInfo
	for _, s := range scenes {
		if s.Name == sceneName {
			scene = &s
			break
		}
	}

	if scene == nil {
		return nil, ErrSceneNotFound
	}

	// Get sources for the scene
	sources, err := c.GetSceneSources(ctx, sceneName)
	if err != nil {
		return nil, err
	}
	scene.Sources = sources

	return scene, nil
}
