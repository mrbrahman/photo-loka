package collections

import (
	"database/sql"
	"encoding/json"
	"fmt"
)

// Collection represents a full collection record from the database.
type Collection struct {
	CollectionID         int64           `json:"collection_id"`
	CollectionName       string          `json:"collection_name"`
	CollectionPath       string          `json:"collection_path"`
	AlbumType            string          `json:"album_type"`
	IntakeConfigs        json.RawMessage `json:"intake_configs"`
	ApplyFolderPattern   string          `json:"apply_folder_pattern"`
	DefaultCollection    *int            `json:"default_collection"`
	TrashDays            int             `json:"trash_days"`
	CompressVideos       *int            `json:"compress_videos"`
	PlaceholderAlbumText *string         `json:"placeholder_album_text"`
}

// CollectionSummary is a lightweight view of a collection for list endpoints.
type CollectionSummary struct {
	CollectionID         int64   `json:"collection_id"`
	CollectionName       string  `json:"collection_name"`
	DefaultCollection    *int    `json:"default_collection"`
	ApplyFolderPattern   string  `json:"apply_folder_pattern"`
	PlaceholderAlbumText *string `json:"placeholder_album_text"`
}

// CollectionsDB provides database operations for collections.
type CollectionsDB struct {
	db *sql.DB
}

// NewCollectionsDB creates a new CollectionsDB instance.
func NewCollectionsDB(conn *sql.DB) *CollectionsDB {
	return &CollectionsDB{db: conn}
}

// Create inserts a new collection and returns the new collection_id.
func (c *CollectionsDB) Create(col *Collection) (int64, error) {
	query := `
		INSERT INTO collections (
			collection_name, collection_path, album_type, intake_configs,
			apply_folder_pattern, default_collection, trash_days,
			compress_videos, placeholder_album_text
		) VALUES (?, ?, ?, json(?), ?, ?, ?, ?, ?)`

	result, err := c.db.Exec(query,
		col.CollectionName,
		col.CollectionPath,
		col.AlbumType,
		string(col.IntakeConfigs),
		col.ApplyFolderPattern,
		col.DefaultCollection,
		col.TrashDays,
		col.CompressVideos,
		col.PlaceholderAlbumText,
	)
	if err != nil {
		return 0, fmt.Errorf("inserting collection: %w", err)
	}

	id, err := result.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("getting last insert id: %w", err)
	}

	return id, nil
}

// Update updates an existing collection by ID.
func (c *CollectionsDB) Update(collectionID int64, col *Collection) error {
	query := `
		UPDATE collections SET
			collection_name = ?,
			collection_path = ?,
			album_type = ?,
			intake_configs = json(?),
			apply_folder_pattern = ?,
			default_collection = ?,
			trash_days = ?,
			compress_videos = ?,
			placeholder_album_text = ?
		WHERE collection_id = ?`

	result, err := c.db.Exec(query,
		col.CollectionName,
		col.CollectionPath,
		col.AlbumType,
		string(col.IntakeConfigs),
		col.ApplyFolderPattern,
		col.DefaultCollection,
		col.TrashDays,
		col.CompressVideos,
		col.PlaceholderAlbumText,
		collectionID,
	)
	if err != nil {
		return fmt.Errorf("updating collection %d: %w", collectionID, err)
	}

	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("checking rows affected: %w", err)
	}
	if rows == 0 {
		return fmt.Errorf("collection %d not found", collectionID)
	}

	return nil
}

// GetAll returns all collections.
func (c *CollectionsDB) GetAll() ([]Collection, error) {
	query := `
		SELECT collection_id, collection_name, collection_path, album_type,
			   intake_configs, apply_folder_pattern, default_collection,
			   trash_days, compress_videos, placeholder_album_text
		FROM collections`

	rows, err := c.db.Query(query)
	if err != nil {
		return nil, fmt.Errorf("querying collections: %w", err)
	}
	defer rows.Close()

	return scanCollections(rows)
}

// Get returns a single collection by ID.
func (c *CollectionsDB) Get(collectionID int64) (*Collection, error) {
	query := `
		SELECT collection_id, collection_name, collection_path, album_type,
			   intake_configs, apply_folder_pattern, default_collection,
			   trash_days, compress_videos, placeholder_album_text
		FROM collections
		WHERE collection_id = ?`

	col := &Collection{}
	var intakeConfigsStr sql.NullString

	err := c.db.QueryRow(query, collectionID).Scan(
		&col.CollectionID,
		&col.CollectionName,
		&col.CollectionPath,
		&col.AlbumType,
		&intakeConfigsStr,
		&col.ApplyFolderPattern,
		&col.DefaultCollection,
		&col.TrashDays,
		&col.CompressVideos,
		&col.PlaceholderAlbumText,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("querying collection %d: %w", collectionID, err)
	}

	if intakeConfigsStr.Valid {
		col.IntakeConfigs = json.RawMessage(intakeConfigsStr.String)
	}

	return col, nil
}

// GetDefault returns the collection marked as default (default_collection = 1).
func (c *CollectionsDB) GetDefault() (*Collection, error) {
	query := `
		SELECT collection_id, collection_name, collection_path, album_type,
			   intake_configs, apply_folder_pattern, default_collection,
			   trash_days, compress_videos, placeholder_album_text
		FROM collections
		WHERE default_collection = 1`

	col := &Collection{}
	var intakeConfigsStr sql.NullString

	err := c.db.QueryRow(query).Scan(
		&col.CollectionID,
		&col.CollectionName,
		&col.CollectionPath,
		&col.AlbumType,
		&intakeConfigsStr,
		&col.ApplyFolderPattern,
		&col.DefaultCollection,
		&col.TrashDays,
		&col.CompressVideos,
		&col.PlaceholderAlbumText,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("querying default collection: %w", err)
	}

	if intakeConfigsStr.Valid {
		col.IntakeConfigs = json.RawMessage(intakeConfigsStr.String)
	}

	return col, nil
}

// GetSummary returns a lightweight list of all collections.
func (c *CollectionsDB) GetSummary() ([]CollectionSummary, error) {
	query := `
		SELECT collection_id, collection_name, default_collection,
			   apply_folder_pattern, placeholder_album_text
		FROM collections`

	rows, err := c.db.Query(query)
	if err != nil {
		return nil, fmt.Errorf("querying collection summaries: %w", err)
	}
	defer rows.Close()

	var results []CollectionSummary
	for rows.Next() {
		var s CollectionSummary
		if err := rows.Scan(
			&s.CollectionID,
			&s.CollectionName,
			&s.DefaultCollection,
			&s.ApplyFolderPattern,
			&s.PlaceholderAlbumText,
		); err != nil {
			return nil, fmt.Errorf("scanning collection summary: %w", err)
		}
		results = append(results, s)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterating collection summaries: %w", err)
	}

	return results, nil
}

// GetByIntakePath finds the collection whose intake_configs contains the given path.
func (c *CollectionsDB) GetByIntakePath(dirPath string) (*Collection, error) {
	query := `
		SELECT c.collection_id, c.collection_name, c.collection_path, c.album_type,
			   c.intake_configs, c.apply_folder_pattern, c.default_collection,
			   c.trash_days, c.compress_videos, c.placeholder_album_text
		FROM collections c, json_each(c.intake_configs) je
		WHERE json_extract(je.value, '$.path') = ?`

	col := &Collection{}
	var intakeConfigsStr sql.NullString

	err := c.db.QueryRow(query, dirPath).Scan(
		&col.CollectionID,
		&col.CollectionName,
		&col.CollectionPath,
		&col.AlbumType,
		&intakeConfigsStr,
		&col.ApplyFolderPattern,
		&col.DefaultCollection,
		&col.TrashDays,
		&col.CompressVideos,
		&col.PlaceholderAlbumText,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("querying collection by intake path %q: %w", dirPath, err)
	}

	if intakeConfigsStr.Valid {
		col.IntakeConfigs = json.RawMessage(intakeConfigsStr.String)
	}

	return col, nil
}

// SetIntakeStatusByIndex updates the status field of a specific intake config entry by index.
func (c *CollectionsDB) SetIntakeStatusByIndex(collectionID int64, index int, status string) error {
	// Use json_set to update the status at the given array index
	query := fmt.Sprintf(`
		UPDATE collections
		SET intake_configs = json_set(intake_configs, '$[%d].status', ?)
		WHERE collection_id = ?`, index)

	result, err := c.db.Exec(query, status, collectionID)
	if err != nil {
		return fmt.Errorf("setting intake status for collection %d index %d: %w", collectionID, index, err)
	}

	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("checking rows affected: %w", err)
	}
	if rows == 0 {
		return fmt.Errorf("collection %d not found", collectionID)
	}

	return nil
}

// SetAllIntakeStatus updates the status field of all intake config entries for a collection.
func (c *CollectionsDB) SetAllIntakeStatus(collectionID int64, status string) error {
	// First get the current intake_configs to know how many entries exist
	var intakeConfigsStr sql.NullString
	err := c.db.QueryRow(
		"SELECT intake_configs FROM collections WHERE collection_id = ?",
		collectionID,
	).Scan(&intakeConfigsStr)
	if err == sql.ErrNoRows {
		return fmt.Errorf("collection %d not found", collectionID)
	}
	if err != nil {
		return fmt.Errorf("querying collection %d: %w", collectionID, err)
	}

	if !intakeConfigsStr.Valid || intakeConfigsStr.String == "" || intakeConfigsStr.String == "null" {
		return nil
	}

	// Parse to determine count
	var configs []json.RawMessage
	if err := json.Unmarshal([]byte(intakeConfigsStr.String), &configs); err != nil {
		return fmt.Errorf("parsing intake_configs: %w", err)
	}

	// Update each entry's status
	for i := range configs {
		if err := c.SetIntakeStatusByIndex(collectionID, i, status); err != nil {
			return err
		}
	}

	return nil
}

// scanCollections scans rows into a slice of Collection structs.
func scanCollections(rows *sql.Rows) ([]Collection, error) {
	var results []Collection
	for rows.Next() {
		var col Collection
		var intakeConfigsStr sql.NullString

		if err := rows.Scan(
			&col.CollectionID,
			&col.CollectionName,
			&col.CollectionPath,
			&col.AlbumType,
			&intakeConfigsStr,
			&col.ApplyFolderPattern,
			&col.DefaultCollection,
			&col.TrashDays,
			&col.CompressVideos,
			&col.PlaceholderAlbumText,
		); err != nil {
			return nil, fmt.Errorf("scanning collection: %w", err)
		}

		if intakeConfigsStr.Valid {
			col.IntakeConfigs = json.RawMessage(intakeConfigsStr.String)
		}

		results = append(results, col)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterating collections: %w", err)
	}

	return results, nil
}
