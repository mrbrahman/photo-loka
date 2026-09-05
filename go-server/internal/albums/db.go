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
		FROM metadata
		WHERE rowid IN (SELECT rowid FROM metadata_fts_porter WHERE metadata_fts_porter MATCH ?)
		  AND trim(coalesce(album_name, '')) != ''
		  AND coalesce(is_trashed, 0) = 0`

	args := []interface{}{matchExpr}

	if collectionID != nil {
		query += " AND collection_id = ?"
		args = append(args, *collectionID)
	}

	if placeholder != nil && *placeholder != "" {
		query += " AND album_name NOT LIKE '%' || ? || '%'"
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
// Also handles nested albums (sub-folders within the album folder).
func (a *AlbumsDB) UpdateAlbumName(collectionID int64, albumDate, fromName, toName string) error {
	// The filename replacement uses a leading space + album name to match the
	// folder segment within the path (e.g. "2021-01-01 Trip" -> "2021-01-01 Beach")
	fromBase := " " + fromName
	toBase := " " + toName

	// Direct rename: items where album_name matches exactly
	directQuery := `
		UPDATE metadata
		SET album_name = ?,
		    filename = replace(filename, ?, ?)
		WHERE collection_id = ?
		  AND album_date = ?
		  AND album_name = ?`

	_, err := a.db.Exec(directQuery, toName, fromBase, toBase, collectionID, albumDate, fromName)
	if err != nil {
		return fmt.Errorf("updating album name from %q to %q: %w", fromName, toName, err)
	}

	// Nested rename: items where album_name starts with fromName/ (sub-folders)
	nestedQuery := `
		UPDATE metadata
		SET album_name = ? || substr(album_name, length(?) + 1),
		    filename = replace(filename, ?, ?)
		WHERE collection_id = ?
		  AND album_date = ?
		  AND album_name LIKE ? || '/%'`

	_, err = a.db.Exec(nestedQuery, toName, fromName, fromBase, toBase, collectionID, albumDate, fromName)
	if err != nil {
		return fmt.Errorf("updating nested albums from %q to %q: %w", fromName, toName, err)
	}

	return nil
}
