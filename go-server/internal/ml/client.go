package ml

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"time"
)

// Client is an HTTP client for the external ML service.
type Client struct {
	baseURL string
	client  *http.Client
	logger  *slog.Logger
}

// NewClient creates a new ML service client.
func NewClient(baseURL string) *Client {
	return &Client{
		baseURL: baseURL,
		client: &http.Client{
			Timeout: 60 * time.Second,
		},
		logger: slog.Default().With("component", "ml-client"),
	}
}

// RecognizeFaces sends an image to the ML service for face detection and recognition.
func (c *Client) RecognizeFaces(uuid, imagePath string, orientation int, xmpRegions interface{}) (map[string]interface{}, error) {
	body := map[string]interface{}{
		"image_id":    uuid,
		"image_path":  imagePath,
		"orientation": orientation,
	}
	if xmpRegions != nil {
		body["xmp_regions"] = xmpRegions
	}

	return c.doJSONRequest(http.MethodPost, "/faces/recognize", body)
}

// NameFaceCluster assigns a name to a face cluster.
func (c *Client) NameFaceCluster(clusterID, name string) error {
	body := map[string]interface{}{
		"name": name,
	}

	_, err := c.doJSONRequest(http.MethodPut, "/faces/"+url.PathEscape(clusterID), body)
	return err
}

// UpdatePersonName renames a person across all face records.
func (c *Client) UpdatePersonName(oldName, newName string) error {
	body := map[string]interface{}{
		"old_name": oldName,
		"new_name": newName,
	}

	_, err := c.doJSONRequest(http.MethodPost, "/faces/update-name", body)
	return err
}

// GetFaceSuggestions retrieves name suggestions for a face cluster.
func (c *Client) GetFaceSuggestions(clusterID string) (map[string]interface{}, error) {
	endpoint := "/faces/suggestions?cluster_id=" + url.QueryEscape(clusterID)
	return c.doJSONRequest(http.MethodGet, endpoint, nil)
}

// SearchByText performs semantic search by text query.
func (c *Client) SearchByText(query string) (map[string]interface{}, error) {
	body := map[string]interface{}{
		"query": query,
		"limit": 1000,
	}

	return c.doJSONRequest(http.MethodPost, "/search/text", body)
}

// CleanupMLData removes ML data for a given uuid. Logs errors but does not return them.
func (c *Client) CleanupMLData(uuid string) {
	endpoint := "/images/" + url.PathEscape(uuid)

	req, err := http.NewRequest(http.MethodDelete, c.baseURL+endpoint, nil)
	if err != nil {
		c.logger.Error("failed to create cleanup request", "uuid", uuid, "error", err)
		return
	}

	resp, err := c.client.Do(req)
	if err != nil {
		c.logger.Error("failed to cleanup ML data", "uuid", uuid, "error", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		c.logger.Error("ML cleanup returned error status", "uuid", uuid, "status", resp.StatusCode)
	}
}

// doJSONRequest is a helper that marshals a body, makes an HTTP request, and unmarshals the response.
func (c *Client) doJSONRequest(method, endpoint string, body interface{}) (map[string]interface{}, error) {
	var reqBody io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal request body: %w", err)
		}
		reqBody = bytes.NewReader(data)
	}

	req, err := http.NewRequest(method, c.baseURL+endpoint, reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("ML service returned status %d: %s", resp.StatusCode, string(respBody))
	}

	var result map[string]interface{}
	if len(respBody) > 0 {
		if err := json.Unmarshal(respBody, &result); err != nil {
			return nil, fmt.Errorf("failed to unmarshal response: %w", err)
		}
	}

	return result, nil
}
