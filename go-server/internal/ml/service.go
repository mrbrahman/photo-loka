package ml

import (
	"encoding/json"
	"fmt"
	"log/slog"

	"photo-loka/internal/media"
)

// Service orchestrates ML operations including face recognition and semantic search.
type Service struct {
	client   *Client
	db       *MLDB
	facesDir string
	logger   *slog.Logger
}

// NewService creates a new ML Service.
func NewService(client *Client, db *MLDB, facesDir string) *Service {
	return &Service{
		client:   client,
		db:       db,
		facesDir: facesDir,
		logger:   slog.Default().With("component", "ml-service"),
	}
}

// ProcessFaceRecognition runs face recognition for a media item.
// It retrieves item info from the DB, calls the ML client, and saves results.
func (s *Service) ProcessFaceRecognition(uuid string) (map[string]interface{}, error) {
	// Get item info from DB for the ML call
	item, err := s.db.GetItemForRecognition(uuid)
	if err != nil {
		return nil, fmt.Errorf("failed to get item info for %s: %w", uuid, err)
	}

	var xmpRegions interface{}
	if item.Xmpregion != nil && *item.Xmpregion != "" {
		// Parse the JSON string into an object before sending to ML service
		if err := json.Unmarshal([]byte(*item.Xmpregion), &xmpRegions); err != nil {
			// If parsing fails, send nil (ML service will proceed without XMP data)
			xmpRegions = nil
		}
	}

	// Call ML service
	result, err := s.client.RecognizeFaces(uuid, item.Filename, item.Orientation, xmpRegions)
	if err != nil {
		return nil, fmt.Errorf("face recognition failed for %s: %w", uuid, err)
	}

	// Extract faces and unmatched from result
	var faces []map[string]interface{}
	var unmatched []map[string]interface{}

	if f, ok := result["faces"].([]interface{}); ok {
		for _, item := range f {
			if m, ok := item.(map[string]interface{}); ok {
				faces = append(faces, m)
			}
		}
	}

	if u, ok := result["unmatched_input_faces"].([]interface{}); ok {
		for _, item := range u {
			if m, ok := item.(map[string]interface{}); ok {
				unmatched = append(unmatched, m)
			}
		}
	}

	// Save results to DB
	if err := s.db.SaveFaceResults(uuid, faces, unmatched); err != nil {
		return nil, fmt.Errorf("failed to save face results for %s: %w", uuid, err)
	}

	// Extract face thumbnails from the image (crop each detected face)
	if len(faces) > 0 {
		if err := media.ExtractFaceThumbnails(uuid, item.Filename, faces, s.facesDir); err != nil {
			s.logger.Warn("face thumbnail extraction failed", "uuid", uuid, "error", err)
		}
	}

	s.logger.Info("face recognition complete", "uuid", uuid, "faces", len(faces), "unmatched", len(unmatched))
	return result, nil
}

// GetFacesByUUID returns all face records for a given uuid.
func (s *Service) GetFacesByUUID(uuid string) ([]map[string]interface{}, error) {
	return s.db.GetFacesByUUID(uuid)
}

// GetFacesByPerson returns all face records for a given person name.
func (s *Service) GetFacesByPerson(name string) ([]map[string]interface{}, error) {
	return s.db.GetFacesByPerson(name)
}

// NameFaceCluster assigns a name to a face cluster in both the ML service and DB.
func (s *Service) NameFaceCluster(clusterID, name string) (int64, error) {
	// Update ML service
	if err := s.client.NameFaceCluster(clusterID, name); err != nil {
		return 0, fmt.Errorf("failed to name cluster in ML service: %w", err)
	}

	// Update local DB
	rowsAffected, err := s.db.NameFaceCluster(clusterID, name)
	if err != nil {
		return 0, fmt.Errorf("failed to name cluster in DB: %w", err)
	}

	s.logger.Info("named face cluster", "cluster_id", clusterID, "name", name, "rows_affected", rowsAffected)
	return rowsAffected, nil
}

// UpdatePersonName renames a person in both the ML service and DB.
func (s *Service) UpdatePersonName(oldName, newName string) (int64, error) {
	// Update ML service
	if err := s.client.UpdatePersonName(oldName, newName); err != nil {
		return 0, fmt.Errorf("failed to update person name in ML service: %w", err)
	}

	// Update local DB
	rowsAffected, err := s.db.UpdatePersonName(oldName, newName)
	if err != nil {
		return 0, fmt.Errorf("failed to update person name in DB: %w", err)
	}

	s.logger.Info("updated person name", "old_name", oldName, "new_name", newName, "rows_affected", rowsAffected)
	return rowsAffected, nil
}

// GetFaceSuggestions retrieves name suggestions for a face cluster from the ML service.
func (s *Service) GetFaceSuggestions(clusterID string) (map[string]interface{}, error) {
	return s.client.GetFaceSuggestions(clusterID)
}

// SearchPersonNames searches for person names matching a query string.
func (s *Service) SearchPersonNames(query string) ([]string, error) {
	return s.db.SearchPersonNames(query)
}

// DismissCluster marks a face cluster as dismissed.
func (s *Service) DismissCluster(clusterID string) error {
	return s.db.DismissCluster(clusterID)
}

// UndismissCluster restores a dismissed face cluster.
func (s *Service) UndismissCluster(clusterID string) error {
	return s.db.UndismissCluster(clusterID)
}

// CleanupMLData removes all ML data for a uuid from both the DB and external ML service.
func (s *Service) CleanupMLData(uuid string) {
	// Delete from local DB
	clusterIDs, err := s.db.DeleteFaceData(uuid)
	if err != nil {
		s.logger.Error("failed to delete face data from DB", "uuid", uuid, "error", err)
	} else if len(clusterIDs) > 0 {
		s.logger.Info("deleted face data", "uuid", uuid, "cluster_ids", clusterIDs)
	}

	// Call ML service cleanup (logs errors internally)
	s.client.CleanupMLData(uuid)
}
