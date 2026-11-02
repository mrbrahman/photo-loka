package upload

import (
	"os"
	"path/filepath"

	"photo-loka/internal/collections"
)

// CleanupEmptySessionDirs is the global daily cron handler. It scans every
// collection's ui_intake_upload_path and removes empty immediate child dirs
// (the per-session staging dirs). It never recurses, never removes the base
// path, and never touches a dir that still contains files: a non-empty session
// dir is either an abandoned upload (replaced on re-pick) or files that failed
// intake for lack of a capture date, both of which are left for an admin to
// clean up manually.
func CleanupEmptySessionDirs() {
	cols, err := collections.GetAll()
	if err != nil {
		uploadLogger().Error("cleanup: failed to list collections", "error", err)
		return
	}

	removed := 0
	for i := range cols {
		base := cols[i].UIIntakeUploadPath
		if base == nil || *base == "" {
			continue
		}
		removed += cleanupBase(*base)
	}

	if removed > 0 {
		uploadLogger().Info("cleanup: removed empty upload session dirs", "count", removed)
	}
}

// cleanupBase removes empty immediate child directories of basePath and returns
// how many were removed.
func cleanupBase(basePath string) int {
	entries, err := os.ReadDir(basePath)
	if err != nil {
		uploadLogger().Warn("cleanup: cannot read upload base", "path", basePath, "error", err)
		return 0
	}

	removed := 0
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		childPath := filepath.Join(basePath, entry.Name())

		children, err := os.ReadDir(childPath)
		if err != nil {
			uploadLogger().Warn("cleanup: cannot read session dir", "path", childPath, "error", err)
			continue
		}
		if len(children) > 0 {
			continue // not empty: abandoned upload or failed intake, leave for admin
		}

		if err := os.Remove(childPath); err != nil {
			uploadLogger().Warn("cleanup: failed to remove empty session dir", "path", childPath, "error", err)
			continue
		}
		removed++
	}

	return removed
}
