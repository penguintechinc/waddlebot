package obs

import (
	"context"
	"time"
)

// GetRecordingStatus returns the current recording status
func (c *Client) GetRecordingStatus(ctx context.Context) (*RecordingStatus, error) {
	if !c.IsConnected() {
		return nil, ErrNotConnected
	}

	resp, err := c.client.Record.GetRecordStatus()
	if err != nil {
		return nil, NewOBSError(ErrOperationFailed, err.Error())
	}

	return &RecordingStatus{
		Active:         resp.OutputActive,
		Paused:         resp.OutputPaused,
		TimecodeString: resp.OutputTimecode,
		Duration:       time.Duration(resp.OutputDuration) * time.Millisecond,
		BytesWritten:   int64(resp.OutputBytes),
		OutputPath:     "", // Not returned by GetRecordStatus
	}, nil
}

// StartRecording starts recording
func (c *Client) StartRecording(ctx context.Context) error {
	if !c.IsConnected() {
		return ErrNotConnected
	}

	_, err := c.client.Record.StartRecord()
	if err != nil {
		return NewOBSError(ErrOperationFailed, err.Error())
	}

	c.logger.Info("Started recording")

	// Emit event
	c.emitEvent(Event{
		Type:      EventRecordingStarted,
		Timestamp: time.Now(),
	})

	return nil
}

// StopRecording stops recording and returns the output path
func (c *Client) StopRecording(ctx context.Context) (string, error) {
	if !c.IsConnected() {
		return "", ErrNotConnected
	}

	resp, err := c.client.Record.StopRecord()
	if err != nil {
		return "", NewOBSError(ErrOperationFailed, err.Error())
	}

	c.logger.WithField("output_path", resp.OutputPath).Info("Stopped recording")

	// Emit event
	c.emitEvent(Event{
		Type:      EventRecordingStopped,
		Timestamp: time.Now(),
		Data: map[string]interface{}{
			"output_path": resp.OutputPath,
		},
	})

	return resp.OutputPath, nil
}

// ToggleRecording toggles the recording state
func (c *Client) ToggleRecording(ctx context.Context) error {
	if !c.IsConnected() {
		return ErrNotConnected
	}

	_, err := c.client.Record.ToggleRecord()
	if err != nil {
		return NewOBSError(ErrOperationFailed, err.Error())
	}

	c.logger.Info("Toggled recording")

	return nil
}

// PauseRecording pauses the current recording
func (c *Client) PauseRecording(ctx context.Context) error {
	if !c.IsConnected() {
		return ErrNotConnected
	}

	_, err := c.client.Record.PauseRecord()
	if err != nil {
		return NewOBSError(ErrOperationFailed, err.Error())
	}

	c.logger.Info("Paused recording")

	// Emit event
	c.emitEvent(Event{
		Type:      EventRecordingPaused,
		Timestamp: time.Now(),
	})

	return nil
}

// ResumeRecording resumes a paused recording
func (c *Client) ResumeRecording(ctx context.Context) error {
	if !c.IsConnected() {
		return ErrNotConnected
	}

	_, err := c.client.Record.ResumeRecord()
	if err != nil {
		return NewOBSError(ErrOperationFailed, err.Error())
	}

	c.logger.Info("Resumed recording")

	// Emit event
	c.emitEvent(Event{
		Type:      EventRecordingResumed,
		Timestamp: time.Now(),
	})

	return nil
}

// ToggleRecordingPause toggles the recording pause state
func (c *Client) ToggleRecordingPause(ctx context.Context) (bool, error) {
	if !c.IsConnected() {
		return false, ErrNotConnected
	}

	resp, err := c.client.Record.ToggleRecordPause()
	if err != nil {
		return false, NewOBSError(ErrOperationFailed, err.Error())
	}

	c.logger.WithField("paused", resp.OutputPaused).Info("Toggled recording pause")

	return resp.OutputPaused, nil
}

// IsRecording returns true if currently recording
func (c *Client) IsRecording(ctx context.Context) (bool, error) {
	status, err := c.GetRecordingStatus(ctx)
	if err != nil {
		return false, err
	}
	return status.Active, nil
}

// IsRecordingPaused returns true if recording is paused
func (c *Client) IsRecordingPaused(ctx context.Context) (bool, error) {
	status, err := c.GetRecordingStatus(ctx)
	if err != nil {
		return false, err
	}
	return status.Paused, nil
}

// GetRecordingDuration returns the current recording duration
func (c *Client) GetRecordingDuration(ctx context.Context) (time.Duration, error) {
	status, err := c.GetRecordingStatus(ctx)
	if err != nil {
		return 0, err
	}
	return status.Duration, nil
}

// GetRecordDirectory returns the recording output directory
func (c *Client) GetRecordDirectory(ctx context.Context) (string, error) {
	if !c.IsConnected() {
		return "", ErrNotConnected
	}

	resp, err := c.client.Config.GetRecordDirectory()
	if err != nil {
		return "", NewOBSError(ErrOperationFailed, err.Error())
	}

	return resp.RecordDirectory, nil
}
