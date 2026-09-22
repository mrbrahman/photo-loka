package config

import (
	"database/sql"
	"fmt"
	"strconv"
	"sync"
)

// RuntimeConfig holds configuration that can change at runtime, persisted in
// the runtime_config key/value table. Values are stored as raw TEXT scalars
// (e.g. 'libvpx-vp9', '4', 'true'); the type of each key is known here, so the
// loader parses each column with the appropriate typed parser and the setters
// write typed values. No data_type column and no reflection are involved.
//
// The struct is the in-memory source of truth: it is loaded once at startup and
// shared (by pointer) with the packages that consume it. The mutex guards
// concurrent access to the fields across goroutines.
type RuntimeConfig struct {
	mu sync.RWMutex `json:"-"`
	db *sql.DB      `json:"-"`

	StartFileWatcherAtStartup       bool   `json:"startFileWatcherAtStartup"`
	StartScheduledIndexingAtStartup bool   `json:"startScheduledIndexingAtStartup"`
	AuditFiles                      bool   `json:"auditFiles"`
	GeonamesHourlyLimit             int    `json:"geonamesHourlyLimit"`
	GeonamesDailyLimit              int    `json:"geonamesDailyLimit"`
	VideoEncoder                    string `json:"videoEncoder"`
	MaxConcurrency                  int    `json:"maxConcurrency"`
	PerformFaceRecognition          bool   `json:"performFaceRecognition"`
}

// Rt is the process-wide runtime config singleton. It is set by
// LoadRuntimeConfig at startup and referenced directly by packages that need
// runtime settings, instead of threading a *RuntimeConfig through constructors.
var Rt *RuntimeConfig

// LoadRuntimeConfig reads all rows from runtime_config and populates the struct.
// Defaults are seeded by migration 013, so a fresh DB already has every key.
// A key with no matching row keeps the Go zero value (so any newly added
// setting must seed its default in a migration); a malformed stored value for a
// typed key is a hard error, surfacing a corrupted/hand-edited row.
//
// The loaded instance is also published as the package-level singleton Rt.
func LoadRuntimeConfig(db *sql.DB) (*RuntimeConfig, error) {
	rc := &RuntimeConfig{db: db}

	rows, err := db.Query("SELECT key, value FROM runtime_config")
	if err != nil {
		return nil, fmt.Errorf("reading runtime config: %w", err)
	}
	defer rows.Close()

	raw := make(map[string]string)
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, fmt.Errorf("scanning runtime config row: %w", err)
		}
		raw[k] = v
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterating runtime config rows: %w", err)
	}

	// Each key is parsed with its known type. Missing keys keep the zero value.
	var perr error
	getBool := func(key string, dst *bool) {
		if s, ok := raw[key]; ok {
			b, err := strconv.ParseBool(s)
			if err != nil {
				perr = fmt.Errorf("config key %q: invalid boolean %q: %w", key, s, err)
				return
			}
			*dst = b
		}
	}
	getInt := func(key string, dst *int) {
		if s, ok := raw[key]; ok {
			n, err := strconv.Atoi(s)
			if err != nil {
				perr = fmt.Errorf("config key %q: invalid integer %q: %w", key, s, err)
				return
			}
			*dst = n
		}
	}
	getStr := func(key string, dst *string) {
		if s, ok := raw[key]; ok {
			*dst = s // raw value stored as-is
		}
	}

	getBool("startFileWatcherAtStartup", &rc.StartFileWatcherAtStartup)
	getBool("startScheduledIndexingAtStartup", &rc.StartScheduledIndexingAtStartup)
	getBool("auditFiles", &rc.AuditFiles)
	getInt("geonamesHourlyLimit", &rc.GeonamesHourlyLimit)
	getInt("geonamesDailyLimit", &rc.GeonamesDailyLimit)
	getStr("videoEncoder", &rc.VideoEncoder)
	getInt("maxConcurrency", &rc.MaxConcurrency)
	getBool("performFaceRecognition", &rc.PerformFaceRecognition)

	if perr != nil {
		return nil, perr
	}

	// Publish as the process-wide singleton.
	Rt = rc
	return rc, nil
}

// setField persists one key as a raw TEXT scalar and, only on success, updates
// the in-memory field. Generic over T so the value and field pointer keep their
// concrete types: no interface{}, no type assertion, no reflection. Callers
// hold rc.mu.
func setField[T any](rc *RuntimeConfig, key string, field *T, v T) error {
	// fmt %v yields the raw scalar: bool -> "true"/"false", int -> "4",
	// string -> the string itself.
	raw := fmt.Sprintf("%v", v)
	if _, err := rc.db.Exec(
		`INSERT INTO runtime_config (key, value) VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		key, raw,
	); err != nil {
		return fmt.Errorf("writing runtime config %q: %w", key, err)
	}
	*field = v
	return nil
}

// Typed setters. Each locks, persists, then assigns via setField. Adding a new
// setting means: add a struct field, a setter here, a loader line above, and a
// seed row in a migration.

func (rc *RuntimeConfig) SetStartFileWatcherAtStartup(v bool) error {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	return setField(rc, "startFileWatcherAtStartup", &rc.StartFileWatcherAtStartup, v)
}

func (rc *RuntimeConfig) SetStartScheduledIndexingAtStartup(v bool) error {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	return setField(rc, "startScheduledIndexingAtStartup", &rc.StartScheduledIndexingAtStartup, v)
}

func (rc *RuntimeConfig) SetAuditFiles(v bool) error {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	return setField(rc, "auditFiles", &rc.AuditFiles, v)
}

func (rc *RuntimeConfig) SetGeonamesHourlyLimit(v int) error {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	return setField(rc, "geonamesHourlyLimit", &rc.GeonamesHourlyLimit, v)
}

func (rc *RuntimeConfig) SetGeonamesDailyLimit(v int) error {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	return setField(rc, "geonamesDailyLimit", &rc.GeonamesDailyLimit, v)
}

func (rc *RuntimeConfig) SetVideoEncoder(v string) error {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	return setField(rc, "videoEncoder", &rc.VideoEncoder, v)
}

func (rc *RuntimeConfig) SetMaxConcurrency(v int) error {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	return setField(rc, "maxConcurrency", &rc.MaxConcurrency, v)
}

func (rc *RuntimeConfig) SetPerformFaceRecognition(v bool) error {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	return setField(rc, "performFaceRecognition", &rc.PerformFaceRecognition, v)
}

// Get retrieves the current in-memory value of a config field by its JSON key
// name. Used by the admin handler to echo the stored value back after an update.
func (rc *RuntimeConfig) Get(key string) (interface{}, error) {
	rc.mu.RLock()
	defer rc.mu.RUnlock()

	switch key {
	case "startFileWatcherAtStartup":
		return rc.StartFileWatcherAtStartup, nil
	case "startScheduledIndexingAtStartup":
		return rc.StartScheduledIndexingAtStartup, nil
	case "auditFiles":
		return rc.AuditFiles, nil
	case "geonamesHourlyLimit":
		return rc.GeonamesHourlyLimit, nil
	case "geonamesDailyLimit":
		return rc.GeonamesDailyLimit, nil
	case "videoEncoder":
		return rc.VideoEncoder, nil
	case "maxConcurrency":
		return rc.MaxConcurrency, nil
	case "performFaceRecognition":
		return rc.PerformFaceRecognition, nil
	default:
		return nil, fmt.Errorf("unknown config key: %q", key)
	}
}
