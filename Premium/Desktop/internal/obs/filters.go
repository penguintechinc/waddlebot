package obs

import (
	"context"

	"github.com/andreykaipov/goobs/api/requests/filters"
)

// GetSourceFilters returns all filters for a source
func (c *Client) GetSourceFilters(ctx context.Context, sourceName string) ([]FilterInfo, error) {
	if !c.IsConnected() {
		return nil, ErrNotConnected
	}

	resp, err := c.client.Filters.GetSourceFilterList(&filters.GetSourceFilterListParams{
		SourceName: &sourceName,
	})
	if err != nil {
		return nil, NewOBSError(ErrOperationFailed, err.Error())
	}

	filterList := make([]FilterInfo, len(resp.Filters))
	for i, f := range resp.Filters {
		filterList[i] = FilterInfo{
			Name:     f.FilterName,
			Type:     f.FilterKind,
			Index:    f.FilterIndex,
			Enabled:  f.FilterEnabled,
			Settings: f.FilterSettings,
		}
	}

	return filterList, nil
}

// GetFilter returns a specific filter on a source
func (c *Client) GetFilter(ctx context.Context, sourceName, filterName string) (*FilterInfo, error) {
	if !c.IsConnected() {
		return nil, ErrNotConnected
	}

	resp, err := c.client.Filters.GetSourceFilter(&filters.GetSourceFilterParams{
		SourceName: &sourceName,
		FilterName: &filterName,
	})
	if err != nil {
		return nil, NewOBSError(ErrFilterNotFound, err.Error())
	}

	return &FilterInfo{
		Name:     filterName,
		Type:     resp.FilterKind,
		Index:    resp.FilterIndex,
		Enabled:  resp.FilterEnabled,
		Settings: resp.FilterSettings,
	}, nil
}

// SetFilterEnabled enables or disables a filter
func (c *Client) SetFilterEnabled(ctx context.Context, sourceName, filterName string, enabled bool) error {
	if !c.IsConnected() {
		return ErrNotConnected
	}

	_, err := c.client.Filters.SetSourceFilterEnabled(&filters.SetSourceFilterEnabledParams{
		SourceName:    &sourceName,
		FilterName:    &filterName,
		FilterEnabled: &enabled,
	})
	if err != nil {
		return NewOBSError(ErrOperationFailed, err.Error())
	}

	c.logger.WithFields(map[string]interface{}{
		"source":  sourceName,
		"filter":  filterName,
		"enabled": enabled,
	}).Debug("Set filter enabled state")

	return nil
}

// SetFilterSettings updates the settings of a filter
func (c *Client) SetFilterSettings(ctx context.Context, sourceName, filterName string, settings map[string]interface{}) error {
	if !c.IsConnected() {
		return ErrNotConnected
	}

	overlay := true
	_, err := c.client.Filters.SetSourceFilterSettings(&filters.SetSourceFilterSettingsParams{
		SourceName:     &sourceName,
		FilterName:     &filterName,
		FilterSettings: settings,
		Overlay:        &overlay,
	})
	if err != nil {
		return NewOBSError(ErrOperationFailed, err.Error())
	}

	c.logger.WithFields(map[string]interface{}{
		"source":   sourceName,
		"filter":   filterName,
		"settings": settings,
	}).Debug("Updated filter settings")

	return nil
}

// SetFilterIndex changes the order/index of a filter
func (c *Client) SetFilterIndex(ctx context.Context, sourceName, filterName string, index int) error {
	if !c.IsConnected() {
		return ErrNotConnected
	}

	_, err := c.client.Filters.SetSourceFilterIndex(&filters.SetSourceFilterIndexParams{
		SourceName:  &sourceName,
		FilterName:  &filterName,
		FilterIndex: &index,
	})
	if err != nil {
		return NewOBSError(ErrOperationFailed, err.Error())
	}

	c.logger.WithFields(map[string]interface{}{
		"source": sourceName,
		"filter": filterName,
		"index":  index,
	}).Debug("Set filter index")

	return nil
}

// CreateFilter creates a new filter on a source
func (c *Client) CreateFilter(ctx context.Context, sourceName, filterName, filterKind string, settings map[string]interface{}) error {
	if !c.IsConnected() {
		return ErrNotConnected
	}

	_, err := c.client.Filters.CreateSourceFilter(&filters.CreateSourceFilterParams{
		SourceName:     &sourceName,
		FilterName:     &filterName,
		FilterKind:     &filterKind,
		FilterSettings: settings,
	})
	if err != nil {
		return NewOBSError(ErrOperationFailed, err.Error())
	}

	c.logger.WithFields(map[string]interface{}{
		"source": sourceName,
		"filter": filterName,
		"kind":   filterKind,
	}).Info("Created filter")

	return nil
}

// RemoveFilter removes a filter from a source
func (c *Client) RemoveFilter(ctx context.Context, sourceName, filterName string) error {
	if !c.IsConnected() {
		return ErrNotConnected
	}

	_, err := c.client.Filters.RemoveSourceFilter(&filters.RemoveSourceFilterParams{
		SourceName: &sourceName,
		FilterName: &filterName,
	})
	if err != nil {
		return NewOBSError(ErrOperationFailed, err.Error())
	}

	c.logger.WithFields(map[string]interface{}{
		"source": sourceName,
		"filter": filterName,
	}).Info("Removed filter")

	return nil
}

// RenameFilter renames a filter
func (c *Client) RenameFilter(ctx context.Context, sourceName, oldFilterName, newFilterName string) error {
	if !c.IsConnected() {
		return ErrNotConnected
	}

	_, err := c.client.Filters.SetSourceFilterName(&filters.SetSourceFilterNameParams{
		SourceName:    &sourceName,
		FilterName:    &oldFilterName,
		NewFilterName: &newFilterName,
	})
	if err != nil {
		return NewOBSError(ErrOperationFailed, err.Error())
	}

	c.logger.WithFields(map[string]interface{}{
		"source":   sourceName,
		"old_name": oldFilterName,
		"new_name": newFilterName,
	}).Info("Renamed filter")

	return nil
}

// ToggleFilter toggles the enabled state of a filter
func (c *Client) ToggleFilter(ctx context.Context, sourceName, filterName string) (bool, error) {
	// Get current state
	filter, err := c.GetFilter(ctx, sourceName, filterName)
	if err != nil {
		return false, err
	}

	// Toggle it
	newState := !filter.Enabled
	err = c.SetFilterEnabled(ctx, sourceName, filterName, newState)
	if err != nil {
		return false, err
	}

	return newState, nil
}
