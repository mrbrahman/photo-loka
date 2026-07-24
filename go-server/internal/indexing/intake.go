package indexing

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

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
		"collection_id", collectionID,
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
