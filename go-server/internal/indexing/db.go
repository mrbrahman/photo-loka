package indexing

import (
	"database/sql"
	"fmt"
	"strings"
)

// IndexingDB provides database operations for the indexer.
type IndexingDB struct {
	db *sql.DB
}

// IndexedFile represents a file that has already been indexed.
type IndexedFile struct {
	UUID           string
	Filename       string
	FileModifiedAt string
}

// AuditEntry represents a single file operation for batch audit logging.
type AuditEntry struct {
	Action string
	Path1  string
	Path2  string
}

// metadataColumns is the ordered list of columns for the metadata table.
var metadataColumns = []string{
	"collection_id", "uuid", "album_date", "album_name", "filename",
	"description", "filesize", "ext", "mimetype", "mediatype",
	"keywords", "xmpregion", "faces", "rating",
	"image_width", "image_height", "aspectratio", "make", "model",
	"orientation", "duration", "gps_lat", "gps_lng", "gps_alt",
	"file_modified_at", "captured_at", "capture_date", "capture_time",
	"capture_tz_offset", "capture_tz_name",
	"exif_datetime_original_ref", "exif_create_date_ref", "indexed_at",
}

// NewIndexingDB creates a new IndexingDB instance.
func NewIndexingDB(conn *sql.DB) *IndexingDB {
	return &IndexingDB{db: conn}
}

// InsertMetadata inserts a new row into the metadata table.
// The row map keys should correspond to column names. indexed_at is set automatically.
func (d *IndexingDB) InsertMetadata(row map[string]interface{}) error {
	// Build columns and values from the map, plus indexed_at
	var cols []string
	var placeholders []string
	var args []interface{}

	for _, col := range metadataColumns {
		if col == "indexed_at" {
			cols = append(cols, "indexed_at")
			placeholders = append(placeholders, "datetime('now','localtime')")
			continue
		}
		if val, ok := row[col]; ok {
			cols = append(cols, col)
			placeholders = append(placeholders, "?")
			args = append(args, val)
		}
	}

	query := fmt.Sprintf(
		"INSERT INTO metadata (%s) VALUES (%s)",
		strings.Join(cols, ", "),
		strings.Join(placeholders, ", "),
	)

	_, err := d.db.Exec(query, args...)
	if err != nil {
		return fmt.Errorf("inserting metadata: %w", err)
	}

	return nil
}

// UpdateMetadata updates an existing metadata row identified by uuid.
// The row map keys should correspond to column names. indexed_at is updated automatically.
func (d *IndexingDB) UpdateMetadata(row map[string]interface{}) error {
	uuid, ok := row["uuid"]
	if !ok {
		return fmt.Errorf("row map must contain 'uuid' key")
	}

	var setClauses []string
	var args []interface{}

	for _, col := range metadataColumns {
		if col == "uuid" {
			continue // skip uuid in SET clause
		}
		if col == "indexed_at" {
			continue // indexed_at is only set on INSERT, never on UPDATE
		}
		if val, ok := row[col]; ok {
			setClauses = append(setClauses, col+" = ?")
			args = append(args, val)
		}
	}

	if len(setClauses) == 0 {
		return nil
	}

	args = append(args, uuid)
	query := fmt.Sprintf(
		"UPDATE metadata SET %s WHERE uuid = ?",
		strings.Join(setClauses, ", "),
	)

	_, err := d.db.Exec(query, args...)
	if err != nil {
		return fmt.Errorf("updating metadata for uuid %v: %w", uuid, err)
	}

	return nil
}

// DeleteMetadata removes a metadata row by uuid.
func (d *IndexingDB) DeleteMetadata(uuid string) error {
	_, err := d.db.Exec("DELETE FROM metadata WHERE uuid = ?", uuid)
	if err != nil {
		return fmt.Errorf("deleting metadata for uuid %s: %w", uuid, err)
	}
	return nil
}

// GetIndexedFiles returns all indexed files for a given collection.
func (d *IndexingDB) GetIndexedFiles(collectionID int64) ([]IndexedFile, error) {
	query := `SELECT uuid, filename, file_modified_at FROM metadata WHERE collection_id = ?`

	rows, err := d.db.Query(query, collectionID)
	if err != nil {
		return nil, fmt.Errorf("querying indexed files for collection %d: %w", collectionID, err)
	}
	defer rows.Close()

	var files []IndexedFile
	for rows.Next() {
		var f IndexedFile
		var fileModAt sql.NullString
		if err := rows.Scan(&f.UUID, &f.Filename, &fileModAt); err != nil {
			return nil, fmt.Errorf("scanning indexed file: %w", err)
		}
		if fileModAt.Valid {
			f.FileModifiedAt = fileModAt.String
		}
		files = append(files, f)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterating indexed files: %w", err)
	}

	return files, nil
}

// GetFileName returns the filename for a given uuid.
func (d *IndexingDB) GetFileName(uuid string) (string, error) {
	var filename string
	err := d.db.QueryRow("SELECT filename FROM metadata WHERE uuid = ?", uuid).Scan(&filename)
	if err == sql.ErrNoRows {
		return "", fmt.Errorf("uuid %s not found", uuid)
	}
	if err != nil {
		return "", fmt.Errorf("querying filename for uuid %s: %w", uuid, err)
	}
	return filename, nil
}

// GetFileNames returns a uuid->filename map for the given uuids.
func (d *IndexingDB) GetFileNames(uuids []string) (map[string]string, error) {
	if len(uuids) == 0 {
		return make(map[string]string), nil
	}

	placeholders := make([]string, len(uuids))
	args := make([]interface{}, len(uuids))
	for i, uuid := range uuids {
		placeholders[i] = "?"
		args[i] = uuid
	}

	query := fmt.Sprintf(
		"SELECT uuid, filename FROM metadata WHERE uuid IN (%s)",
		strings.Join(placeholders, ", "),
	)

	rows, err := d.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("querying filenames: %w", err)
	}
	defer rows.Close()

	result := make(map[string]string)
	for rows.Next() {
		var uuid, filename string
		if err := rows.Scan(&uuid, &filename); err != nil {
			return nil, fmt.Errorf("scanning filename row: %w", err)
		}
		result[uuid] = filename
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterating filenames: %w", err)
	}

	return result, nil
}

// TrashItem marks an item as trashed by updating its filename to the trash path.
func (d *IndexingDB) TrashItem(uuid, trashFilename string) error {
	_, err := d.db.Exec(
		"UPDATE metadata SET filename = ?, is_trashed = 1, trashed_at = datetime('now','localtime') WHERE uuid = ?",
		trashFilename, uuid,
	)
	if err != nil {
		return fmt.Errorf("trashing item %s: %w", uuid, err)
	}
	return nil
}

// UntrashItem restores a trashed item by updating its filename.
func (d *IndexingDB) UntrashItem(uuid, restoredFilename string) error {
	_, err := d.db.Exec(
		"UPDATE metadata SET filename = ?, is_trashed = 0, trashed_at = null WHERE uuid = ?",
		restoredFilename, uuid,
	)
	if err != nil {
		return fmt.Errorf("untrashing item %s: %w", uuid, err)
	}
	return nil
}

// MarkPrivate marks an item as private by updating its filename.
func (d *IndexingDB) MarkPrivate(uuid, newFilename string) error {
	_, err := d.db.Exec(
		"UPDATE metadata SET filename = ?, is_private = 1 WHERE uuid = ?",
		newFilename, uuid,
	)
	if err != nil {
		return fmt.Errorf("marking private %s: %w", uuid, err)
	}
	return nil
}

// UnmarkPrivate removes the private flag from an item and updates its filename.
func (d *IndexingDB) UnmarkPrivate(uuid, newFilename string) error {
	_, err := d.db.Exec(
		"UPDATE metadata SET filename = ?, is_private = 0 WHERE uuid = ?",
		newFilename, uuid,
	)
	if err != nil {
		return fmt.Errorf("unmarking private %s: %w", uuid, err)
	}
	return nil
}

// UpdateDescription updates the description and file_modified_at for an item.
func (d *IndexingDB) UpdateDescription(uuid, description, fileModifyDate string) error {
	_, err := d.db.Exec(
		"UPDATE metadata SET description = ?, file_modified_at = ? WHERE uuid = ?",
		description, fileModifyDate, uuid,
	)
	if err != nil {
		return fmt.Errorf("updating description for %s: %w", uuid, err)
	}
	return nil
}

// UpdateFilename updates the filename for an item.
func (d *IndexingDB) UpdateFilename(uuid, filename string) error {
	_, err := d.db.Exec(
		"UPDATE metadata SET filename = ? WHERE uuid = ?",
		filename, uuid,
	)
	if err != nil {
		return fmt.Errorf("updating filename for %s: %w", uuid, err)
	}
	return nil
}

// UpdateRating updates the rating for multiple items in a transaction.
func (d *IndexingDB) UpdateRating(uuids []string, rating int, fileModifyDate string) error {
	if len(uuids) == 0 {
		return nil
	}

	tx, err := d.db.Begin()
	if err != nil {
		return fmt.Errorf("beginning transaction: %w", err)
	}
	defer tx.Rollback()

	stmt, err := tx.Prepare("UPDATE metadata SET rating = ?, file_modified_at = ? WHERE uuid = ?")
	if err != nil {
		return fmt.Errorf("preparing update rating statement: %w", err)
	}
	defer stmt.Close()

	for _, uuid := range uuids {
		if _, err := stmt.Exec(rating, fileModifyDate, uuid); err != nil {
			return fmt.Errorf("updating rating for %s: %w", uuid, err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("committing rating update: %w", err)
	}

	return nil
}

// ScheduleExif inserts rows into the exif_updates table to schedule exif writes.
// NOTE: The actual write-back job (reading pending updates and calling exiftool to
// write them back to the files) is not implemented. Node.js also has the table and
// insert logic but never implemented the processing job (getPendingExifUpdates exists
// but is never called). Updates accumulate in the table for future implementation.
func (d *IndexingDB) ScheduleExif(uuids []string, newExifJSON string) error {
	if len(uuids) == 0 {
		return nil
	}

	tx, err := d.db.Begin()
	if err != nil {
		return fmt.Errorf("beginning transaction: %w", err)
	}
	defer tx.Rollback()

	stmt, err := tx.Prepare(
		"INSERT INTO exif_updates (uuid, new_exif_json) VALUES (?, ?)",
	)
	if err != nil {
		return fmt.Errorf("preparing exif schedule statement: %w", err)
	}
	defer stmt.Close()

	for _, uuid := range uuids {
		if _, err := stmt.Exec(uuid, newExifJSON); err != nil {
			return fmt.Errorf("scheduling exif write for %s: %w", uuid, err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("committing exif schedule: %w", err)
	}

	return nil
}

// FileAudit logs a single file operation to the file_audit table.
func (d *IndexingDB) FileAudit(collectionID int64, action, path1 string, path2 *string) error {
	_, err := d.db.Exec(
		"INSERT INTO file_audit_log (collection_id, action, path1, path2) VALUES (?, ?, ?, ?)",
		collectionID, action, path1, path2,
	)
	if err != nil {
		return fmt.Errorf("inserting file audit: %w", err)
	}
	return nil
}

// FileAuditBatch logs multiple file operations in a transaction.
func (d *IndexingDB) FileAuditBatch(collectionID int64, entries []AuditEntry) error {
	if len(entries) == 0 {
		return nil
	}

	tx, err := d.db.Begin()
	if err != nil {
		return fmt.Errorf("beginning transaction: %w", err)
	}
	defer tx.Rollback()

	stmt, err := tx.Prepare(
		"INSERT INTO file_audit_log (collection_id, action, path1, path2) VALUES (?, ?, ?, ?)",
	)
	if err != nil {
		return fmt.Errorf("preparing file audit statement: %w", err)
	}
	defer stmt.Close()

	for _, entry := range entries {
		var path2 interface{}
		if entry.Path2 != "" {
			path2 = entry.Path2
		}
		if _, err := stmt.Exec(collectionID, entry.Action, entry.Path1, path2); err != nil {
			return fmt.Errorf("inserting file audit entry: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("committing file audit batch: %w", err)
	}

	return nil
}

// UpdateAlbumForItem updates the album_date, album_name, and filename for a single item.
func (d *IndexingDB) UpdateAlbumForItem(uuid, albumDate, albumName, filename string) error {
	_, err := d.db.Exec(
		"UPDATE metadata SET album_date = ?, album_name = ?, filename = ? WHERE uuid = ?",
		albumDate, albumName, filename, uuid,
	)
	if err != nil {
		return fmt.Errorf("updating album for item %s: %w", uuid, err)
	}
	return nil
}

// InsertGeoLookup stores exiftool geolocation data in the geo_lookups table.
func (d *IndexingDB) InsertGeoLookup(uuid, source, apiName string, responseJSON string) error {
	_, err := d.db.Exec(
		`INSERT OR REPLACE INTO geo_lookups (uuid, source, api_name, response_json, fetched_at)
		 VALUES (?, ?, ?, ?, datetime('now','localtime'))`,
		uuid, source, apiName, responseJSON,
	)
	if err != nil {
		return fmt.Errorf("inserting geo lookup for %s: %w", uuid, err)
	}
	return nil
}
