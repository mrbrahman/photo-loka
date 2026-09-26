package indexing

import (
	"fmt"
	"strconv"

	"photo-loka/internal/collections"
	"photo-loka/internal/utils"
)

// InitialIndexing lists all files in a collection, filters ignored files,
// and enqueues each for indexing with High priority.
func InitialIndexing(collectionID int64) error {
	collection, err := collections.Get(collectionID)
	if err != nil {
		return fmt.Errorf("getting collection %d: %w", collectionID, err)
	}
	if collection == nil {
		return fmt.Errorf("collection %d not found", collectionID)
	}

	files, err := ListAllFiles(collection.CollectionPath)
	if err != nil {
		return fmt.Errorf("listing files for collection %d: %w", collectionID, err)
	}

	var enqueued int
	for _, file := range files {
		if utils.ShouldIgnoreFile(file) {
			continue
		}
		submit(collection, file, "", true)
		enqueued++
	}

	idxLogger().Info("initial indexing started",
		"collection_id", collectionID,
		"files_enqueued", enqueued,
	)

	return nil
}

// ScanForChanges compares disk file modification times against the database
// and enqueues added or changed files for re-indexing.
//
// NOTE: Deleted files (present in DB but not on disk) are detected but NOT acted on.
// Node.js also detects deletions but does not trash/remove them automatically.
// This is intentional - automatic deletion is risky; user should handle manually.
func ScanForChanges(collectionID int64) error {
	collection, err := collections.Get(collectionID)
	if err != nil {
		return fmt.Errorf("getting collection %d: %w", collectionID, err)
	}
	if collection == nil {
		return fmt.Errorf("collection %d not found", collectionID)
	}

	// Get current disk state
	diskFiles, err := GetFilesMtime(collection.CollectionPath)
	if err != nil {
		return fmt.Errorf("getting disk files for collection %d: %w", collectionID, err)
	}

	// Get indexed state from DB
	indexedFiles, err := GetIndexedFiles(collectionID)
	if err != nil {
		return fmt.Errorf("getting indexed files for collection %d: %w", collectionID, err)
	}

	// Build a map of filename -> indexed file for lookup
	indexedMap := make(map[string]*IndexedFile, len(indexedFiles))
	for i := range indexedFiles {
		indexedMap[indexedFiles[i].Filename] = &indexedFiles[i]
	}

	var addedCount, changedCount int

	for diskFile, diskMtime := range diskFiles {
		if utils.ShouldIgnoreFile(diskFile) {
			continue
		}

		indexed, exists := indexedMap[diskFile]
		if !exists {
			// New file - not yet indexed
			addedCount++
			submit(collection, diskFile, "", true)
		} else {
			// Check if file has been modified since last index
			if indexed.FileModifiedAt != "" {
				indexedMtime, err := parseMtimeString(indexed.FileModifiedAt)
				if err == nil && diskMtime > indexedMtime {
					// File changed since last index
					changedCount++
					submit(collection, diskFile, indexed.UUID, true)
				}
			}
		}
	}

	// Detect files in DB but no longer on disk (deleted).
	// We do not act on these automatically - deletion is risky and must be handled manually.
	var deletedCount int
	for filename := range indexedMap {
		if _, onDisk := diskFiles[filename]; !onDisk {
			deletedCount++
		}
	}

	idxLogger().Info("scan for changes complete",
		"collection_id", collectionID,
		"added", addedCount,
		"changed", changedCount,
		"total_enqueued", addedCount+changedCount,
	)

	if deletedCount > 0 {
		idxLogger().Warn("scan for changes: files missing from disk (deleted?); skipped - admin must review and trash/remove manually",
			"collection_id", collectionID,
			"deleted_count", deletedCount,
		)
	}

	return nil
}

// RefreshMetadataForCollection re-extracts metadata for all indexed files in a collection.
func RefreshMetadataForCollection(collectionID int64) error {
	indexedFiles, err := GetIndexedFiles(collectionID)
	if err != nil {
		return fmt.Errorf("getting indexed files for refresh, collection %d: %w", collectionID, err)
	}

	for _, file := range indexedFiles {
		submitRefresh(file.UUID, file.Filename)
	}

	idxLogger().Info("metadata refresh started",
		"collection_id", collectionID,
		"files_enqueued", len(indexedFiles),
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

	// Otherwise parse via the shared exifdate helper, which handles the
	// exiftool native format and the ISO variants (with/without timezone).
	if dt, ok := utils.ParseExifDate(s); ok {
		return dt.Unix(), nil
	}

	return 0, fmt.Errorf("unable to parse mtime string: %s", s)
}
