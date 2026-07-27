package indexing

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"photo-loka/internal/collections"
	"photo-loka/internal/queue"
	"photo-loka/internal/utils"
)

// StartIntakeFileIndexing finds pending files in the intake directory that are
// older than staleDays, and enqueues each for indexing (inPlace=false).
func (idx *Indexer) StartIntakeFileIndexing(collectionID int64, dir string, staleDays int) error {
	collection, err := idx.collectionsDB.Get(collectionID)
	if err != nil {
		return fmt.Errorf("getting collection %d: %w", collectionID, err)
	}
	if collection == nil {
		return fmt.Errorf("collection %d not found", collectionID)
	}

	return idx.enqueueIntakeFiles(collection, dir, staleDays)
}

// StartIntakeByDir finds the collection that owns the given intake path and runs indexing.
func (idx *Indexer) StartIntakeByDir(dir string, staleDays int) error {
	collection, err := idx.collectionsDB.GetByIntakePath(dir)
	if err != nil {
		return fmt.Errorf("finding collection for intake path %s: %w", dir, err)
	}
	if collection == nil {
		return fmt.Errorf("directory %s not found in any collection intake configs", dir)
	}

	// If staleDays not explicitly provided, try to get from the intake config
	if staleDays <= 0 {
		staleDays = idx.getStaleDaysForPath(collection, dir)
	}

	return idx.enqueueIntakeFiles(collection, dir, staleDays)
}

// StartIntakeForCollection runs intake indexing for all scheduled intake paths in a collection.
func (idx *Indexer) StartIntakeForCollection(collectionID int64, staleDays int) error {
	collection, err := idx.collectionsDB.Get(collectionID)
	if err != nil {
		return fmt.Errorf("getting collection %d: %w", collectionID, err)
	}
	if collection == nil {
		return fmt.Errorf("collection %d not found", collectionID)
	}

	intakeConfigs := parseIntakeConfigs(collection)
	for _, ic := range intakeConfigs {
		method, _ := ic["method"].(string)
		if method != "scheduled" {
			continue
		}
		path, _ := ic["path"].(string)
		if path == "" {
			continue
		}

		days := staleDays
		if days <= 0 {
			if cfg, ok := ic["config"].(map[string]interface{}); ok {
				if sd, ok := cfg["staleDays"].(float64); ok {
					days = int(sd)
				}
			}
		}
		if days <= 0 {
			days = 1
		}

		if err := idx.enqueueIntakeFiles(collection, path, days); err != nil {
			idx.logger.Error("intake indexing failed for path", "path", path, "error", err)
		}
	}

	return nil
}

// getStaleDaysForPath extracts the staleDays config for a given intake path.
func (idx *Indexer) getStaleDaysForPath(collection *collections.Collection, dir string) int {
	intakeConfigs := parseIntakeConfigs(collection)
	for _, ic := range intakeConfigs {
		path, _ := ic["path"].(string)
		if path == dir {
			if cfg, ok := ic["config"].(map[string]interface{}); ok {
				if sd, ok := cfg["staleDays"].(float64); ok {
					return int(sd)
				}
			}
		}
	}
	return 1
}

// parseIntakeConfigs parses the JSON intake_configs from a collection.
func parseIntakeConfigs(collection *collections.Collection) []map[string]interface{} {
	if len(collection.IntakeConfigs) == 0 {
		return nil
	}
	var configs []map[string]interface{}
	if err := json.Unmarshal(collection.IntakeConfigs, &configs); err != nil {
		return nil
	}
	return configs
}

func (idx *Indexer) enqueueIntakeFiles(collection *collections.Collection, dir string, staleDays int) error {

	cutoffTime := time.Now().AddDate(0, 0, -staleDays)

	files, err := findPendingFiles(dir, cutoffTime)
	if err != nil {
		return fmt.Errorf("finding pending files in %s: %w", dir, err)
	}

	var tasks []queue.Task
	for _, file := range files {
		f := file
		col := collection
		tasks = append(tasks, queue.Task{
			Priority:    queue.High,
			Description: f,
			Fn: func() error {
				return idx.IndexFile(col, f, "", false)
			},
		})
	}

	if len(tasks) > 0 {
		idx.indexQueue.EnqueueMany(tasks)
	}

	idx.logger.Info("intake indexing started",
		"collection_id", collection.CollectionID,
		"dir", dir,
		"stale_days", staleDays,
		"files_enqueued", len(tasks),
	)

	return nil
}

// findPendingFiles walks the directory and returns files older than cutoffTime,
// filtering out ignored files.
func findPendingFiles(dirPath string, cutoffTime time.Time) ([]string, error) {
	var pending []string

	err := filepath.Walk(dirPath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		if info.IsDir() {
			return nil
		}

		if utils.ShouldIgnoreFile(path) {
			return nil
		}

		// Check if file modification time is before cutoff (i.e., file is "stale")
		if info.ModTime().Before(cutoffTime) {
			pending = append(pending, path)
		}

		return nil
	})

	if err != nil {
		return nil, fmt.Errorf("walking intake directory %s: %w", dirPath, err)
	}

	return pending, nil
}
