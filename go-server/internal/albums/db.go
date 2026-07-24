package albums

import (
	"database/sql"
	"fmt"
	"strings"
)

// AlbumsDB provides database operations for albums.
type AlbumsDB struct {
	db *sql.DB
}

// AlbumSearchResult represents a matching album name and its item count.
type AlbumSearchResult struct {
	Similar string `json:"similar"`
	Count   int    `json:"cnt"`
}

// NewAlbumsDB creates a new AlbumsDB instance.
func NewAlbumsDB(conn *sql.DB) *AlbumsDB {
	return &AlbumsDB{db: conn}
}

// SearchForExisting searches the FTS porter index for album names matching the search string.
// It excludes albums matching the placeholder text and limits results to 10.
func (a *AlbumsDB) SearchForExisting(searchStr string, collectionID *int64, placeholder *string) ([]AlbumSearchResult, error) {
	// Build the FTS match expression
	// Prefix match with asterisk
	matchExpr := `{album_name}: "` + strings.ReplaceAll(searchStr, `"`, `""`) + `"*`

	query := `
		SELECT album_name as similar, count(*) as cnt
		FROM metadata_fts_porter
		JOIN metadata USING(rowid)
		WHERE metadata_fts_porter MATCH ?
		  AND coalesce(is_trashed, 0) = 0`

	args := []interface{}{matchExpr}

	if collectionID != nil {
		query += " AND collection_id = ?"
		args = append(args, *collectionID)
	}

	if placeholder != nil && *placeholder != "" {
		query += " AND album_name != ?"
		args = append(args, *placeholder)
	}

	query += `
		GROUP BY album_name
		ORDER BY cnt DESC
		LIMIT 10`

	rows, err := a.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("searching albums: %w", err)
	}
	defer rows.Close()

	var results []AlbumSearchResult
	for rows.Next() {
		var r AlbumSearchResult
		if err := rows.Scan(&r.Similar, &r.Count); err != nil {
			return nil, fmt.Errorf("scanning album search result: %w", err)
		}
		results = append(results, r)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterating album search results: %w", err)
	}

	return results, nil
}

// UpdateAlbumName renames an album by updating all metadata records matching
// the given collection, album_date, and current album name.
// It updates both the album_name field and the filename path (replacing the folder component).
func (a *AlbumsDB) UpdateAlbumName(collectionID int64, albumDate, fromName, toName string) error {
	// Update album_name and replace the folder name component in filename
	// This handles both direct items (in the album folder) and nested items (subfolders)
	query := `
		UPDATE metadata
		SET album_name = ?,
		    filename = replace(filename, ?, ?)
		WHERE collection_id = ?
		  AND album_date = ?
		  AND album_name = ?`

	result, err := a.db.Exec(query, toName, fromName, toName, collectionID, albumDate, fromName)
	if err != nil {
		return fmt.Errorf("updating album name from %q to %q: %w", fromName, toName, err)
	}

	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("checking rows affected: %w", err)
	}
	if rows == 0 {
		return fmt.Errorf("no items found for album %q on %s in collection %d", fromName, albumDate, collectionID)
	}

	return nil
}
