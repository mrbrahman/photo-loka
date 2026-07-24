package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sync"
)

// RuntimeConfig holds configuration that can change at runtime, persisted as JSON.
type RuntimeConfig struct {
	mu sync.RWMutex `json:"-"`

	dataDir string `json:"-"`

	StartFileWatcherAtStartup            bool   `json:"startFileWatcherAtStartup"`
	StartScheduledIndexingAtStartup      bool   `json:"startScheduledIndexingAtStartup"`
	ScanFilesForChangesAndIndexAtStartup bool   `json:"scanFilesForChangesAndIndexAtStartup"`
	FilesDeletedThreshold                int    `json:"filesDeletedThreshold"`
	AuditFiles                           bool   `json:"auditFiles"`
	GeonamesHourlyLimit                  int    `json:"geonamesHourlyLimit"`
	GeonamesDailyLimit                   int    `json:"geonamesDailyLimit"`
	VideoEncoder                         string `json:"videoEncoder"`
	MaxConcurrency                       int    `json:"maxConcurrency"`
	PerformFaceRecognition               bool   `json:"performFaceRecognition"`
}

// LoadRuntimeConfig reads the runtime config from DataDir/runtime-config.json.
func LoadRuntimeConfig(dataDir string) (*RuntimeConfig, error) {
	rc := &RuntimeConfig{dataDir: dataDir}

	configPath := filepath.Join(dataDir, "runtime-config.json")
	data, err := os.ReadFile(configPath)
	if err != nil {
		if os.IsNotExist(err) {
			// Return default config if file doesn't exist
			return rc, nil
		}
		return nil, fmt.Errorf("reading runtime config: %w", err)
	}

	if err := json.Unmarshal(data, rc); err != nil {
		return nil, fmt.Errorf("parsing runtime config: %w", err)
	}

	return rc, nil
}

// Save writes the runtime config back to DataDir/runtime-config.json.
func (rc *RuntimeConfig) Save(dataDir string) error {
	rc.mu.RLock()
	data, err := json.MarshalIndent(rc, "", "  ")
	rc.mu.RUnlock()
	if err != nil {
		return fmt.Errorf("marshaling runtime config: %w", err)
	}

	configPath := filepath.Join(dataDir, "runtime-config.json")
	if err := os.WriteFile(configPath, data, 0644); err != nil {
		return fmt.Errorf("writing runtime config: %w", err)
	}

	return nil
}

// Update updates a field by its JSON key name and saves the config.
func (rc *RuntimeConfig) Update(key string, value interface{}) error {
	rc.mu.Lock()
	defer rc.mu.Unlock()

	rv := reflect.ValueOf(rc).Elem()
	rt := rv.Type()

	// Find the field matching the JSON tag
	fieldIdx := -1
	for i := 0; i < rt.NumField(); i++ {
		field := rt.Field(i)
		tag := field.Tag.Get("json")
		if tag == "" || tag == "-" {
			continue
		}
		if tag == key {
			fieldIdx = i
			break
		}
	}

	if fieldIdx == -1 {
		return fmt.Errorf("unknown config key: %q", key)
	}

	field := rv.Field(fieldIdx)
	if !field.CanSet() {
		return fmt.Errorf("cannot set field for key: %q", key)
	}

	// Convert value to the appropriate type
	switch field.Kind() {
	case reflect.Bool:
		b, ok := value.(bool)
		if !ok {
			return fmt.Errorf("key %q expects bool, got %T", key, value)
		}
		field.SetBool(b)
	case reflect.Int, reflect.Int64:
		switch v := value.(type) {
		case float64:
			field.SetInt(int64(v))
		case int:
			field.SetInt(int64(v))
		case int64:
			field.SetInt(v)
		default:
			return fmt.Errorf("key %q expects int, got %T", key, value)
		}
	case reflect.String:
		s, ok := value.(string)
		if !ok {
			return fmt.Errorf("key %q expects string, got %T", key, value)
		}
		field.SetString(s)
	default:
		return fmt.Errorf("unsupported field type for key %q: %s", key, field.Kind())
	}

	// Save after update (release write lock temporarily for save)
	data, err := json.MarshalIndent(rc, "", "  ")
	if err != nil {
		return fmt.Errorf("marshaling runtime config: %w", err)
	}

	configPath := filepath.Join(rc.dataDir, "runtime-config.json")
	if err := os.WriteFile(configPath, data, 0644); err != nil {
		return fmt.Errorf("writing runtime config: %w", err)
	}

	return nil
}
