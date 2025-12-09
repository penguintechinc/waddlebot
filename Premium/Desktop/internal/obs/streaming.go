package obs

import (
	"context"
	"time"

	"github.com/andreykaipov/goobs/api/requests/stream"
)

// GetStreamStatus returns the current streaming status
func (c *Client) GetStreamStatus(ctx context.Context) (*StreamStatus, error) {
	if !c.IsConnected() {
		return nil, ErrNotConnected
	}

	resp, err := c.client.Stream.GetStreamStatus()
	if err != nil {
		return nil, NewOBSError(ErrOperationFailed, err.Error())
	}

	return &StreamStatus{
		Active:              resp.OutputActive,
		Reconnecting:        resp.OutputReconnecting,
		TimecodeString:      resp.OutputTimecode,
		Duration:            time.Duration(resp.OutputDuration) * time.Millisecond,
		BytesSent:           int64(resp.OutputBytes),
		KbitsPerSec:         int64(resp.OutputCongestion), // Note: congestion is 0-1, use different metric if available
		DroppedFrames:       int64(resp.OutputSkippedFrames),
		TotalFrames:         int64(resp.OutputTotalFrames),
		RenderSkippedFrames: 0, // Not available in stream status
		OutputSkippedFrames: int64(resp.OutputSkippedFrames),
	}, nil
}

// StartStream starts streaming
func (c *Client) StartStream(ctx context.Context) error {
	if !c.IsConnected() {
		return ErrNotConnected
	}

	_, err := c.client.Stream.StartStream()
	if err != nil {
		return NewOBSError(ErrOperationFailed, err.Error())
	}

	c.logger.Info("Started streaming")

	// Emit event
	c.emitEvent(Event{
		Type:      EventStreamStarted,
		Timestamp: time.Now(),
	})

	return nil
}

// StopStream stops streaming
func (c *Client) StopStream(ctx context.Context) error {
	if !c.IsConnected() {
		return ErrNotConnected
	}

	_, err := c.client.Stream.StopStream()
	if err != nil {
		return NewOBSError(ErrOperationFailed, err.Error())
	}

	c.logger.Info("Stopped streaming")

	// Emit event
	c.emitEvent(Event{
		Type:      EventStreamStopped,
		Timestamp: time.Now(),
	})

	return nil
}

// ToggleStream toggles the streaming state
func (c *Client) ToggleStream(ctx context.Context) (bool, error) {
	if !c.IsConnected() {
		return false, ErrNotConnected
	}

	resp, err := c.client.Stream.ToggleStream()
	if err != nil {
		return false, NewOBSError(ErrOperationFailed, err.Error())
	}

	c.logger.WithField("active", resp.OutputActive).Info("Toggled streaming")

	return resp.OutputActive, nil
}

// SendStreamCaption sends a caption/subtitle to the stream
func (c *Client) SendStreamCaption(ctx context.Context, caption string) error {
	if !c.IsConnected() {
		return ErrNotConnected
	}

	_, err := c.client.Stream.SendStreamCaption(&stream.SendStreamCaptionParams{
		CaptionText: &caption,
	})
	if err != nil {
		return NewOBSError(ErrOperationFailed, err.Error())
	}

	c.logger.WithField("caption_length", len(caption)).Debug("Sent stream caption")

	return nil
}

// IsStreaming returns true if currently streaming
func (c *Client) IsStreaming(ctx context.Context) (bool, error) {
	status, err := c.GetStreamStatus(ctx)
	if err != nil {
		return false, err
	}
	return status.Active, nil
}

// GetStreamDuration returns the current stream duration
func (c *Client) GetStreamDuration(ctx context.Context) (time.Duration, error) {
	status, err := c.GetStreamStatus(ctx)
	if err != nil {
		return 0, err
	}
	return status.Duration, nil
}
