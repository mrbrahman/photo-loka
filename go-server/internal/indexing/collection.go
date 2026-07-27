package indexing

import (
	"fmt"
	"strconv"
	"time"

	"photo-loka/internal/queue"
	"photo-loka/internal/utils"
)

// InitialIndexing lists all files in a collection, filters ignored files,
// and enqueues each for indexing with High priority.
func (idx *Indexer) InitialIndexing(collectionID int64) error {
	collection, err := idx.collectionsDB.Get(collectionID)
	if err != nil {
		return fmt.Errorf("getting collection %d: %w", collectionID, err)
	}
	if collection == nil {
		return fmt.Errorf("collection %d not found", collectionID)
	}

	files, err := idx.organizer.ListAllFiles(collection.CollectionPath)
	if err != nil {
		return fmt.Errorf("listing files for collection %d: %w", collectionID, err)
	}

	var tasks []queue.Task
	for _, file := range files {
		if utils.ShouldIgnoreFile(file) {
			continue
		}

		// Capture loop variable
		f := file
		col := collection
		tasks = append(tasks, queue.Task{
			Priority:    queue.High,
			Description: f,
			Fn: func() error {
				return idx.IndexFile(col, f, "", true)
			},
		})
	}

	if len(tasks) > 0 {
		idx.indexQueue.EnqueueMany(tasks)
	}

	idx.logger.Info("initial indexing started",
		"collection_id", collectionID,
		"files_enqueued", len(tasks),
	)

	return nil
}

// ScanForChanges compares disk file modification times against the database
// and enqueues added or changed files for re-indexing.
//
// NOTE: Deleted files (present in DB but not on disk) are detected but NOT acted on.
// Node.js also detects deletions but does not trash/remove them automatically.
// This is intentional — automatic deletion is risky; user should handle manually.
//
// NOTE: filesDeletedThreshold (runtime config) is not implemented because Node.js
// also defines it but never uses it in any logic.
func (idx *Indexer) ScanForChanges(collectionID int64) error {
	collection, err := idx.collectionsDB.Get(collectionID)
	if err != nil {
		return fmt.Errorf("getting collection %d: %w", collectionID, err)
	}
	if collection == nil {
		return fmt.Errorf("collection %d not found", collectionID)
	}

	// Get current disk state
	diskFiles, err := idx.organizer.GetFilesMtime(collection.CollectionPath)
	if err != nil {
		return fmt.Errorf("getting disk files for collection %d: %w", collectionID, err)
	}

	// Get indexed state from DB
	indexedFiles, err := idx.db.GetIndexedFiles(collectionID)
	if err != nil {
		return fmt.Errorf("getting indexed files for collection %d: %w", collectionID, err)
	}

	// Build a map of filename -> indexed file for lookup
	indexedMap := make(map[string]*IndexedFile, len(indexedFiles))
	for i := range indexedFiles {
		indexedMap[indexedFiles[i].Filename] = &indexedFiles[i]
	}

	var tasks []queue.Task
	for diskFile, diskMtime := range diskFiles {
		if utils.ShouldIgnoreFile(diskFile) {
			continue
		}

		indexed, exists := indexedMap[diskFile]
		if !exists {
			// New file - not yet indexed
			f := diskFile
			col := collection
			tasks = append(tasks, queue.Task{
				Priority:    queue.High,
				Description: f,
				Fn: func() error {
					return idx.IndexFile(col, f, "", true)
				},
			})
		} else {
			// Check if file has been modified since last index
			if indexed.FileModifiedAt != "" {
				indexedMtime, err := parseMtimeString(indexed.FileModifiedAt)
				if err == nil && diskMtime > indexedMtime {
					// File changed since last index
					f := diskFile
					col := collection
					existingUUID := indexed.UUID
					tasks = append(tasks, queue.Task{
						Priority:    queue.High,
						Description: f,
						Fn: func() error {
							return idx.IndexFile(col, f, existingUUID, true)
						},
					})
				}
			}
		}
	}

	if len(tasks) > 0 {
		idx.indexQueue.EnqueueMany(tasks)
	}

	idx.logger.Info("scan for changes complete",
		"collection_id", collectionID,
		"changes_found", len(tasks),
	)

	return nil
}

// RefreshMetadataForCollection re-extracts metadata for all indexed files in a collection.
func (idx *Indexer) RefreshMetadataForCollection(collectionID int64) error {
	indexedFiles, err := idx.db.GetIndexedFiles(collectionID)
	if err != nil {
		return fmt.Errorf("getting indexed files for refresh, collection %d: %w", collectionID, err)
	}

	var tasks []queue.Task
	for _, file := range indexedFiles {
		f := file
		tasks = append(tasks, queue.Task{
			Priority:    queue.Normal,
			Description: f.Filename,
			Fn: func() error {
				return idx.RefreshMetadata(f.UUID, f.Filename)
			},
		})
	}

	if len(tasks) > 0 {
		idx.indexQueue.EnqueueMany(tasks)
	}

	idx.logger.Info("metadata refresh started",
		"collection_id", collectionID,
		"files_enqueued", len(tasks),
	)

	return nil
}

// parseMtimeString attempts to parse a file modification time string into a unix timestamp.
// Handles formats like "2021:01:15 14:30:00+05:30" (exiftool format) or unix timestamp strings.
func parseMtimeString(s string) (int64, error) {
	// Try parsing as unix timestamp first
	if ts, err := strconv.ParseInt(s, 10, 64); err == nil {
		return ts, nil
	}

	// Try common date formats (order: most specific first)
	// RFC3339 handles: 2025-09-15T15:33:29Z, 2026-07-27T14:31:36-04:00, 2025-10-22T21:36:25.270-04:00
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t.Unix(), nil
	}

	// No-colon offset variant from Node.js dateformat 'isoDateTime': 2024-07-27T10:30:00+0530
	if t, err := time.Parse("2006-01-02T15:04:05-0700", s); err == nil {
		return t.Unix(), nil
	}

	// Exiftool native format: 2025:09:15 15:33:29+00:00
	formats := []string{
		"2006:01:02 15:04:05-07:00",
		"2006:01:02 15:04:05",
		"2006-01-02 15:04:05",
	}

	for _, format := range formats {
		if t, err := time.Parse(format, s); err == nil {
			return t.Unix(), nil
		}
	}

	// Last resort: simple datetime treated as local time
	if t, err := time.ParseInLocation("2006-01-02 15:04:05", s, time.Local); err == nil {
		return t.Unix(), nil
	}

	return 0, fmt.Errorf("unable to parse mtime string: %s", s)
}
