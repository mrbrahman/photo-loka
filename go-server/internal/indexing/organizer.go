package indexing

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"photo-loka/internal/collections"
	"photo-loka/internal/config"
	"photo-loka/internal/media"
	"photo-loka/internal/utils"
)

// PlaceResult holds the outcome of placing a file into a collection folder.
type PlaceResult struct {
	AlbumDate string
	AlbumName string
	Filename  string
}

// Organizer handles file placement, moves, and trash operations.
type Organizer struct {
	db     *IndexingDB
	config *config.RuntimeConfig
	logger *slog.Logger
}

// NewOrganizer creates a new Organizer instance.
func NewOrganizer(db *IndexingDB, cfg *config.RuntimeConfig) *Organizer {
	return &Organizer{
		db:     db,
		config: cfg,
		logger: slog.Default().With("component", "organizer"),
	}
}

// PlaceFileInCollection determines the target album folder for a file.
// In-place mode: parses the existing folder path with the collection pattern.
// Intake mode: formats a folder path from capture date and moves the file.
func (o *Organizer) PlaceFileInCollection(collection *collections.Collection, filename string, captureDateTime *media.CaptureDateTime, inPlace bool) (*PlaceResult, error) {
	if inPlace {
		return o.placeInPlace(collection, filename)
	}
	return o.placeIntake(collection, filename, captureDateTime)
}

// placeInPlace parses the folder structure to derive album date and name.
func (o *Organizer) placeInPlace(collection *collections.Collection, filename string) (*PlaceResult, error) {
	// Get relative path from collection root
	relPath, err := filepath.Rel(collection.CollectionPath, filename)
	if err != nil {
		return nil, fmt.Errorf("getting relative path: %w", err)
	}

	// The folder part (without the filename)
	dir := filepath.Dir(relPath)

	// Parse the folder pattern to extract tokens
	parsed := utils.ParsePattern(filepath.ToSlash(dir), collection.ApplyFolderPattern)
	if parsed == nil {
		// Could not parse - use folder name as album name, no date
		return &PlaceResult{
			AlbumDate: "",
			AlbumName: dir,
			Filename:  filename,
		}, nil
	}

	// Build album date from parsed tokens
	albumDate := buildAlbumDate(parsed)
	albumName := parsed["album"]

	return &PlaceResult{
		AlbumDate: albumDate,
		AlbumName: albumName,
		Filename:  filename,
	}, nil
}

// placeIntake formats a target folder from the capture date and moves the file there.
func (o *Organizer) placeIntake(collection *collections.Collection, filename string, captureDateTime *media.CaptureDateTime) (*PlaceResult, error) {
	if captureDateTime == nil {
		return nil, fmt.Errorf("capture date/time is required for intake indexing of %s", filename)
	}

	// Build token values from capture date
	values := map[string]string{
		"yyyy": strconv.Itoa(captureDateTime.Year),
		"yy":   strconv.Itoa(captureDateTime.Year % 100),
		"mm":   strconv.Itoa(captureDateTime.Month),
		"dd":   strconv.Itoa(captureDateTime.Day),
	}

	// Use placeholder album text if configured
	albumName := ""
	if collection.PlaceholderAlbumText != nil {
		albumName = *collection.PlaceholderAlbumText
	}
	values["album"] = albumName

	// Format the folder path
	folderPath, err := utils.FormatPattern(values, collection.ApplyFolderPattern)
	if err != nil {
		return nil, fmt.Errorf("formatting folder pattern: %w", err)
	}

	// Build album date from the same values
	albumDate := buildAlbumDate(values)

	// Create target directory
	targetDir := filepath.Join(collection.CollectionPath, folderPath)
	if err := os.MkdirAll(targetDir, 0755); err != nil {
		return nil, fmt.Errorf("creating target directory %s: %w", targetDir, err)
	}

	// Move file to target directory
	baseName := filepath.Base(filename)
	targetPath := filepath.Join(targetDir, baseName)

	// Handle name collision
	targetPath = resolveNameCollision(targetPath)

	if err := moveFile(filename, targetPath); err != nil {
		return nil, fmt.Errorf("moving file to collection: %w", err)
	}

	o.logger.Info("file placed in collection",
		"source", filename,
		"target", targetPath,
		"album_date", albumDate,
		"album_name", albumName,
	)

	return &PlaceResult{
		AlbumDate: albumDate,
		AlbumName: albumName,
		Filename:  targetPath,
	}, nil
}

// RenameAlbumFolder renames an album folder from one name to another.
func (o *Organizer) RenameAlbumFolder(collection *collections.Collection, currAlbumDate, currAlbumName, newAlbumDate, newAlbumName string) error {
	currPath := o.AlbumFolderAbsPath(collection, currAlbumDate, currAlbumName)
	newPath := o.AlbumFolderAbsPath(collection, newAlbumDate, newAlbumName)

	if currPath == newPath {
		return nil
	}

	// Ensure parent of new path exists
	if err := os.MkdirAll(filepath.Dir(newPath), 0755); err != nil {
		return fmt.Errorf("creating parent directory for %s: %w", newPath, err)
	}

	if err := os.Rename(currPath, newPath); err != nil {
		return fmt.Errorf("renaming album folder from %s to %s: %w", currPath, newPath, err)
	}

	o.logChange(collection.CollectionID, "RENAME_FOLDER", currPath, &newPath)

	o.logger.Info("album folder renamed",
		"from", currPath,
		"to", newPath,
	)

	return nil
}

// AlbumFolderAbsPath returns the absolute path for an album folder.
func (o *Organizer) AlbumFolderAbsPath(collection *collections.Collection, albumDate, albumName string) string {
	// Parse album date
	values := map[string]string{
		"album": albumName,
	}

	if albumDate != "" {
		parts := strings.Split(albumDate, "-")
		if len(parts) >= 3 {
			values["yyyy"] = parts[0]
			values["yy"] = parts[0][2:]
			values["mm"] = parts[1]
			values["dd"] = parts[2]
		}
	}

	folderPath, err := utils.FormatPattern(values, collection.ApplyFolderPattern)
	if err != nil {
		// Fallback: just join date and name
		return filepath.Join(collection.CollectionPath, albumDate+" "+albumName)
	}

	return filepath.Join(collection.CollectionPath, folderPath)
}

// MoveItem moves a file from src to dest, with EXDEV fallback (copy+delete).
// If silent is true, the move is not logged to the file audit table.
func (o *Organizer) MoveItem(collectionID int64, src, dest string, silent bool) error {
	// Ensure destination directory exists
	if err := os.MkdirAll(filepath.Dir(dest), 0755); err != nil {
		return fmt.Errorf("creating destination directory: %w", err)
	}

	if err := moveFile(src, dest); err != nil {
		return fmt.Errorf("moving %s to %s: %w", src, dest, err)
	}

	if !silent {
		o.logChange(collectionID, "MOVE", src, &dest)
	}

	return nil
}

// MoveFileToTrash moves items to the collection's .trash folder.
func (o *Organizer) MoveFileToTrash(collectionID int64, uuids []string) error {
	filenames, err := o.db.GetFileNames(uuids)
	if err != nil {
		return fmt.Errorf("getting filenames for trash: %w", err)
	}

	for _, uuid := range uuids {
		filename, ok := filenames[uuid]
		if !ok {
			o.logger.Warn("uuid not found for trash", "uuid", uuid)
			continue
		}

		// Rename file in-place with '.Trash_' prefix on the basename
		dir := filepath.Dir(filename)
		baseName := filepath.Base(filename)
		trashPath := filepath.Join(dir, ".Trash_"+baseName)

		if err := moveFile(filename, trashPath); err != nil {
			return fmt.Errorf("moving %s to trash: %w", filename, err)
		}

		if err := o.db.TrashItem(uuid, trashPath); err != nil {
			return fmt.Errorf("updating DB for trashed item %s: %w", uuid, err)
		}

		o.logChange(collectionID, "TRASH", filename, &trashPath)
	}

	return nil
}

// RestoreFromTrash restores trashed items by removing the '.Trash_' prefix.
func (o *Organizer) RestoreFromTrash(collectionID int64, uuids []string) error {
	filenames, err := o.db.GetFileNames(uuids)
	if err != nil {
		return fmt.Errorf("getting filenames for restore: %w", err)
	}

	for _, uuid := range uuids {
		trashPath, ok := filenames[uuid]
		if !ok {
			o.logger.Warn("uuid not found for restore", "uuid", uuid)
			continue
		}

		// Remove '.Trash_' prefix from the basename to restore in-place
		dir := filepath.Dir(trashPath)
		baseName := filepath.Base(trashPath)
		restoredName := strings.TrimPrefix(baseName, ".Trash_")
		restoredPath := filepath.Join(dir, restoredName)

		if err := moveFile(trashPath, restoredPath); err != nil {
			return fmt.Errorf("restoring %s from trash: %w", trashPath, err)
		}

		if err := o.db.UntrashItem(uuid, restoredPath); err != nil {
			return fmt.Errorf("updating DB for restored item %s: %w", uuid, err)
		}

		o.logChange(collectionID, "RESTORE", trashPath, &restoredPath)
	}

	return nil
}

// MarkFilePrivate renames files to add a "private_" prefix.
func (o *Organizer) MarkFilePrivate(collectionID int64, uuids []string) error {
	filenames, err := o.db.GetFileNames(uuids)
	if err != nil {
		return fmt.Errorf("getting filenames for mark private: %w", err)
	}

	for _, uuid := range uuids {
		filename, ok := filenames[uuid]
		if !ok {
			o.logger.Warn("uuid not found for mark private", "uuid", uuid)
			continue
		}

		dir := filepath.Dir(filename)
		baseName := filepath.Base(filename)
		newName := "." + baseName
		newPath := filepath.Join(dir, newName)

		if err := os.Rename(filename, newPath); err != nil {
			return fmt.Errorf("renaming %s to private: %w", filename, err)
		}

		if err := o.db.MarkPrivate(uuid, newPath); err != nil {
			return fmt.Errorf("updating DB for private item %s: %w", uuid, err)
		}

		o.logChange(collectionID, "MARK_PRIVATE", filename, &newPath)
	}

	return nil
}

// UnmarkFilePrivate removes the leading dot from filenames.
func (o *Organizer) UnmarkFilePrivate(collectionID int64, uuids []string) error {
	filenames, err := o.db.GetFileNames(uuids)
	if err != nil {
		return fmt.Errorf("getting filenames for unmark private: %w", err)
	}

	for _, uuid := range uuids {
		filename, ok := filenames[uuid]
		if !ok {
			o.logger.Warn("uuid not found for unmark private", "uuid", uuid)
			continue
		}

		dir := filepath.Dir(filename)
		baseName := filepath.Base(filename)
		if !strings.HasPrefix(baseName, ".") {
			continue // not prefixed, nothing to do
		}
		newName := strings.TrimPrefix(baseName, ".")
		newPath := filepath.Join(dir, newName)

		if err := os.Rename(filename, newPath); err != nil {
			return fmt.Errorf("renaming %s to remove private: %w", filename, err)
		}

		if err := o.db.UnmarkPrivate(uuid, newPath); err != nil {
			return fmt.Errorf("updating DB for unprivate item %s: %w", uuid, err)
		}

		o.logChange(collectionID, "UNMARK_PRIVATE", filename, &newPath)
	}

	return nil
}

// ListAllFiles recursively walks a directory and returns all file paths.
func (o *Organizer) ListAllFiles(collectionPath string) ([]string, error) {
	var files []string

	err := filepath.Walk(collectionPath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		// Skip directories named .trash
		if info.IsDir() && info.Name() == ".trash" {
			return filepath.SkipDir
		}

		if !info.IsDir() {
			files = append(files, path)
		}

		return nil
	})

	if err != nil {
		return nil, fmt.Errorf("walking directory %s: %w", collectionPath, err)
	}

	return files, nil
}

// GetFilesMtime returns a map of filename->mtime (unix seconds) for all files in the directory.
func (o *Organizer) GetFilesMtime(dir string) (map[string]int64, error) {
	result := make(map[string]int64)

	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		// Skip .trash directories
		if info.IsDir() && info.Name() == ".trash" {
			return filepath.SkipDir
		}

		if !info.IsDir() {
			result[path] = info.ModTime().Unix()
		}

		return nil
	})

	if err != nil {
		return nil, fmt.Errorf("walking directory %s for mtime: %w", dir, err)
	}

	return result, nil
}

// logChange records a file operation in the audit table if auditing is enabled.
func (o *Organizer) logChange(collectionID int64, action, path1 string, path2 *string) {
	if !o.config.AuditFiles {
		return
	}

	if err := o.db.FileAudit(collectionID, action, path1, path2); err != nil {
		o.logger.Error("failed to log file audit",
			"action", action,
			"path1", path1,
			"error", err,
		)
	}
}

// buildAlbumDate constructs a YYYY-MM-DD string from parsed tokens.
func buildAlbumDate(values map[string]string) string {
	yyyy := values["yyyy"]
	mm := values["mm"]
	dd := values["dd"]

	if yyyy == "" {
		return ""
	}

	parts := []string{yyyy}
	if mm != "" {
		parts = append(parts, mm)
	}
	if dd != "" {
		parts = append(parts, dd)
	}

	return strings.Join(parts, "-")
}

// moveFile moves a file using os.Rename with EXDEV fallback (copy+delete).
func moveFile(src, dest string) error {
	err := os.Rename(src, dest)
	if err == nil {
		return nil
	}

	// Check for cross-device error
	if !errors.Is(err, syscall.EXDEV) {
		return err
	}

	// Cross-device: copy then delete
	if err := copyFile(src, dest); err != nil {
		return fmt.Errorf("cross-device copy: %w", err)
	}

	// Preserve timestamps from source
	srcInfo, statErr := os.Stat(src)
	if statErr == nil {
		os.Chtimes(dest, srcInfo.ModTime(), srcInfo.ModTime())
	}

	if err := os.Remove(src); err != nil {
		// File was copied but original not removed - log but don't fail
		slog.Warn("cross-device move: copied but failed to remove source", "src", src, "error", err)
	}

	return nil
}

// copyFile copies a file from src to dest preserving permissions.
func copyFile(src, dest string) error {
	srcFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer srcFile.Close()

	srcInfo, err := srcFile.Stat()
	if err != nil {
		return err
	}

	destFile, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, srcInfo.Mode())
	if err != nil {
		return err
	}
	defer destFile.Close()

	if _, err := io.Copy(destFile, srcFile); err != nil {
		return err
	}

	return destFile.Sync()
}

// resolveNameCollision appends a counter suffix if the target path already exists.
func resolveNameCollision(targetPath string) string {
	if _, err := os.Stat(targetPath); os.IsNotExist(err) {
		return targetPath
	}

	ext := filepath.Ext(targetPath)
	base := strings.TrimSuffix(targetPath, ext)

	for i := 1; i < 1000; i++ {
		candidate := fmt.Sprintf("%s_%d%s", base, i, ext)
		if _, err := os.Stat(candidate); os.IsNotExist(err) {
			return candidate
		}
	}

	// Extremely unlikely: just return with a large number
	return fmt.Sprintf("%s_9999%s", base, ext)
}


