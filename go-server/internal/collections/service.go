package collections

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"

	"photo-loka/internal/auth"
)

// Valid album types
var validAlbumTypes = map[string]bool{
	"FOLDER_ALBUM":  true,
	"VIRTUAL_ALBUM": true,
}

// Valid intake methods
var validIntakeMethods = map[string]bool{
	"immediate": true,
	"scheduled": true,
	"on-demand": true,
}

// intakeConfig represents a single intake configuration entry for validation.
type intakeConfig struct {
	Path   string `json:"path"`
	Method string `json:"method"`
}

// Service provides business logic for collections.
type Service struct {
	db *CollectionsDB
}

// NewService creates a new collections Service.
func NewService(db *CollectionsDB) *Service {
	return &Service{db: db}
}

// Create validates and creates a new collection.
func (s *Service) Create(col *Collection) (int64, error) {
	if err := validateCollection(col); err != nil {
		return 0, err
	}
	return s.db.Create(col)
}

// Update validates and updates an existing collection.
func (s *Service) Update(collectionID int64, col *Collection) error {
	if err := validateCollection(col); err != nil {
		return err
	}
	return s.db.Update(collectionID, col)
}

// GetAll returns all collections.
func (s *Service) GetAll() ([]Collection, error) {
	return s.db.GetAll()
}

// Get returns a single collection by ID.
func (s *Service) Get(collectionID int64) (*Collection, error) {
	return s.db.Get(collectionID)
}

// GetDefault returns the default collection.
func (s *Service) GetDefault() (*Collection, error) {
	return s.db.GetDefault()
}

// GetSummary returns a lightweight list of collections.
func (s *Service) GetSummary() ([]CollectionSummary, error) {
	return s.db.GetSummary()
}

// ListSubDirs reads a directory and returns the names of its subdirectories.
func (s *Service) ListSubDirs(dirPath string) ([]string, error) {
	entries, err := os.ReadDir(dirPath)
	if err != nil {
		return nil, &auth.AppError{
			Message:    "Cannot read directory: " + err.Error(),
			Code:       "INVALID_PATH",
			StatusCode: http.StatusBadRequest,
		}
	}

	var dirs []string
	for _, entry := range entries {
		if entry.IsDir() {
			dirs = append(dirs, entry.Name())
		}
	}

	return dirs, nil
}

// IsValidDir checks if the given path exists and is a directory.
func (s *Service) IsValidDir(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	return info.IsDir()
}

// SetIntakeStatus updates the status of a single intake config entry.
func (s *Service) SetIntakeStatus(collectionID int64, index int, status string) error {
	return s.db.SetIntakeStatusByIndex(collectionID, index, status)
}

// SetAllIntakeStatus updates the status of all intake config entries.
func (s *Service) SetAllIntakeStatus(collectionID int64, status string) error {
	return s.db.SetAllIntakeStatus(collectionID, status)
}

// validateCollection checks that a collection has valid fields.
func validateCollection(col *Collection) error {
	if col.CollectionName == "" {
		return &auth.AppError{
			Message:    "collection_name is required",
			Code:       "VALIDATION_ERROR",
			StatusCode: http.StatusBadRequest,
		}
	}

	if col.CollectionPath == "" {
		return &auth.AppError{
			Message:    "collection_path is required",
			Code:       "VALIDATION_ERROR",
			StatusCode: http.StatusBadRequest,
		}
	}

	// Validate collection path exists and is a directory
	cleanPath := filepath.Clean(col.CollectionPath)
	info, err := os.Stat(cleanPath)
	if err != nil {
		return &auth.AppError{
			Message:    "collection_path does not exist: " + col.CollectionPath,
			Code:       "INVALID_PATH",
			StatusCode: http.StatusBadRequest,
		}
	}
	if !info.IsDir() {
		return &auth.AppError{
			Message:    "collection_path is not a directory: " + col.CollectionPath,
			Code:       "INVALID_PATH",
			StatusCode: http.StatusBadRequest,
		}
	}

	// Validate album type
	if !validAlbumTypes[col.AlbumType] {
		return &auth.AppError{
			Message:    "album_type must be FOLDER_ALBUM or VIRTUAL_ALBUM",
			Code:       "VALIDATION_ERROR",
			StatusCode: http.StatusBadRequest,
		}
	}

	// Validate intake configs if provided
	if len(col.IntakeConfigs) > 0 && string(col.IntakeConfigs) != "null" {
		var configs []intakeConfig
		if err := json.Unmarshal(col.IntakeConfigs, &configs); err != nil {
			return &auth.AppError{
				Message:    "intake_configs must be a valid JSON array",
				Code:       "VALIDATION_ERROR",
				StatusCode: http.StatusBadRequest,
			}
		}

		for i, cfg := range configs {
			if cfg.Path == "" {
				return &auth.AppError{
					Message:    "intake_configs[" + intToStr(i) + "].path is required",
					Code:       "VALIDATION_ERROR",
					StatusCode: http.StatusBadRequest,
				}
			}

			// Validate intake path exists and is a directory
			intakePath := filepath.Clean(cfg.Path)
			intakeInfo, err := os.Stat(intakePath)
			if err != nil {
				return &auth.AppError{
					Message:    "intake path does not exist: " + cfg.Path,
					Code:       "INVALID_PATH",
					StatusCode: http.StatusBadRequest,
				}
			}
			if !intakeInfo.IsDir() {
				return &auth.AppError{
					Message:    "intake path is not a directory: " + cfg.Path,
					Code:       "INVALID_PATH",
					StatusCode: http.StatusBadRequest,
				}
			}

			if !validIntakeMethods[cfg.Method] {
				return &auth.AppError{
					Message:    "intake_configs[" + intToStr(i) + "].method must be immediate, scheduled, or on-demand",
					Code:       "VALIDATION_ERROR",
					StatusCode: http.StatusBadRequest,
				}
			}
		}
	}

	return nil
}

// intToStr converts an int to string without importing strconv.
func intToStr(i int) string {
	if i == 0 {
		return "0"
	}
	var result []byte
	n := i
	if n < 0 {
		result = append(result, '-')
		n = -n
	}
	digits := []byte{}
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	result = append(result, digits...)
	return string(result)
}
