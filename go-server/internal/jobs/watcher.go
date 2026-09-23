package jobs

import (
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"

	"photo-loka/internal/collections"
	"photo-loka/internal/indexing"
	"photo-loka/internal/queue"
	"photo-loka/internal/utils"
)

// WatcherInfo describes an active file watcher for an intake path.
type WatcherInfo struct {
	CollectionID int64  `json:"collection_id"`
	IntakePath   string `json:"intake_path"`
	watcher      *fsnotify.Watcher
}

// File watching for immediate-mode intake paths is package-level (single
// instance): the active watcher list and its guard are package vars.
var (
	watchersMu sync.Mutex
	watchers   []WatcherInfo
	fwLogger   = slog.Default().With("component", "file-watcher")
)

// StartForAllCollections starts file watchers for all collections with immediate intake paths.
func StartForAllCollections() error {
	cols, err := collections.GetAll()
	if err != nil {
		return err
	}

	for i := range cols {
		StartForCollection(&cols[i])
	}

	return nil
}

// StartForCollection starts file watchers for each immediate intake path in the collection.
func StartForCollection(col *collections.Collection) {
	if col.IntakeConfigs == nil {
		return
	}

	var intakeConfigs []intakeConfig
	if err := json.Unmarshal(col.IntakeConfigs, &intakeConfigs); err != nil {
		fwLogger.Error("failed to parse intake_configs",
			"collection_id", col.CollectionID,
			"error", err,
		)
		return
	}

	for _, cfg := range intakeConfigs {
		if cfg.Method != "immediate" {
			continue
		}
		if cfg.Status == "stopped" {
			continue
		}

		watcher, err := fsnotify.NewWatcher()
		if err != nil {
			fwLogger.Error("failed to create watcher",
				"collection_id", col.CollectionID,
				"path", cfg.Path,
				"error", err,
			)
			continue
		}

		if err := watcher.Add(cfg.Path); err != nil {
			fwLogger.Error("failed to watch path",
				"collection_id", col.CollectionID,
				"path", cfg.Path,
				"error", err,
			)
			watcher.Close()
			continue
		}

		info := WatcherInfo{
			CollectionID: col.CollectionID,
			IntakePath:   cfg.Path,
			watcher:      watcher,
		}

		watchersMu.Lock()
		watchers = append(watchers, info)
		watchersMu.Unlock()

		// Start event handler goroutine
		go handleEvents(watcher, col.CollectionID, cfg.Path)

		fwLogger.Info("watching intake path",
			"collection_id", col.CollectionID,
			"path", cfg.Path,
		)
	}
}

// StopForCollection stops all watchers for a specific collection.
func StopForCollection(collectionID int64) {
	watchersMu.Lock()
	defer watchersMu.Unlock()

	remaining := make([]WatcherInfo, 0, len(watchers))
	for _, w := range watchers {
		if w.CollectionID == collectionID {
			w.watcher.Close()
			fwLogger.Info("stopped watching",
				"collection_id", collectionID,
				"path", w.IntakePath,
			)
		} else {
			remaining = append(remaining, w)
		}
	}
	watchers = remaining
}

// StopAll stops all active watchers.
func StopAll() {
	watchersMu.Lock()
	defer watchersMu.Unlock()

	for _, w := range watchers {
		w.watcher.Close()
	}
	watchers = nil
	fwLogger.Info("all file watchers stopped")
}

// ListAll returns information about all active watchers.
func ListAll() []WatcherInfo {
	watchersMu.Lock()
	defer watchersMu.Unlock()

	result := make([]WatcherInfo, len(watchers))
	for i, w := range watchers {
		result[i] = WatcherInfo{
			CollectionID: w.CollectionID,
			IntakePath:   w.IntakePath,
		}
	}
	return result
}

// handleEvents processes fsnotify events for a watched path.
func handleEvents(watcher *fsnotify.Watcher, collectionID int64, intakePath string) {
	// Debounce map to handle awaitWriteFinish behavior
	pending := make(map[string]time.Time)
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case event, ok := <-watcher.Events:
			if !ok {
				return
			}

			// Only process Create events for new files
			if event.Op&fsnotify.Create != 0 {
				if utils.ShouldIgnoreFile(event.Name) {
					continue
				}
				// Record the file with a timestamp; process after delay
				pending[event.Name] = time.Now()
			}

		case err, ok := <-watcher.Errors:
			if !ok {
				return
			}
			fwLogger.Error("watcher error",
				"collection_id", collectionID,
				"path", intakePath,
				"error", err,
			)

		case <-ticker.C:
			// Process pending files that are old enough (500ms delay for write to finish)
			now := time.Now()
			for filePath, createdAt := range pending {
				if now.Sub(createdAt) >= 500*time.Millisecond {
					enqueueFile(collectionID, filePath)
					delete(pending, filePath)
				}
			}
		}
	}
}

// enqueueFile adds a file to the indexing queue with High priority.
func enqueueFile(collectionID int64, filePath string) {
	collection, err := collections.Get(collectionID)
	if err != nil || collection == nil {
		fwLogger.Error("failed to get collection for enqueue",
			"collection_id", collectionID,
			"file", filePath,
			"error", err,
		)
		return
	}

	col := collection
	f := filePath
	indexing.IndexQueue().Enqueue(queue.Task{
		Priority:    queue.High,
		Description: f,
		Fn: func() error {
			return indexing.IndexFile(col, f, "", false)
		},
	})

	fwLogger.Info("watcher: file added",
		"collection_id", collectionID,
		"file", filePath,
	)
}

// intakeConfig represents a single intake configuration entry.
type intakeConfig struct {
	Path   string          `json:"path"`
	Method string          `json:"method"`
	Status string          `json:"status"`
	Config json.RawMessage `json:"config"`
}
