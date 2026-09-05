package search

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
)

// SearchDB provides database operations for search functionality.
type SearchDB struct {
	db *sql.DB
}

// DayGroup represents a day with its grouped items for the timeline view.
type DayGroup struct {
	Day   string            `json:"day"`
	Items []json.RawMessage `json:"items"`
}

// FlatResult represents a single item with its album name (non-grouped view).
type FlatResult struct {
	Album string          `json:"album"`
	Item  json.RawMessage `json:"item"`
}

// DateRange constrains results to a date window.
type DateRange struct {
	FromDate string
	ToDate   string
}

// NewSearchDB creates a new SearchDB instance.
func NewSearchDB(conn *sql.DB) *SearchDB {
	return &SearchDB{db: conn}
}

// itemSelect is the json_object() SQL expression that produces the standard item JSON shape.
const itemSelect = `
    json_object(
      'albumDate', album_date,
      'albumName', coalesce(album_name, ''),
      'data', json_object(
        'ar', round(aspectratio, 2),
        'id', uuid,
        'type', mediatype,
        'rating', coalesce(rating,0),
        'dur',
          case
            when duration >= 3600 then
              cast(duration/3600 as int) || ':' || substr('0' || cast((duration % 3600)/60 as int), -2) || ':' || substr('0' || cast(duration % 60 as int), -2)
            when duration is not null then
              cast(duration/60 as int) || ':' || substr('0' || cast(duration % 60 as int), -2)
          end,
        'hasGps', case when gps_lat is not null then 1 else 0 end,
        'hasDesc', case when trim(coalesce(description,'')) not in ('', 'null') then 1 else 0 end,
        'hasTags', case when trim(coalesce(keywords,'')) not in ('', 'null', '[null]') then 1 else 0 end,
        'private', case when coalesce(is_private, 0) = 1 then 1 else 0 end,
        't', coalesce(unixepoch(captured_at), 0),
        'hasTime', case when capture_time is not null then 1 else 0 end,
        'localTime', capture_time,
        'tzOffset', capture_tz_offset,
        'tzName', capture_tz_name
      )
    )`

// RunSearch builds and executes a search query, returning either day-grouped or flat results.
func (s *SearchDB) RunSearch(collectionID *int64, searchStr string, trashed bool, groupByDay bool, orderBy string, dateRange *DateRange) (interface{}, error) {
	var filters []string
	limit := false

	// Trashed filter
	trashedVal := 0
	if trashed {
		trashedVal = 1
	}
	filters = append(filters, fmt.Sprintf("coalesce(is_trashed, 0) = %d", trashedVal))

	// Default private filter: only apply if user hasn't explicitly searched for private items
	hasExplicitPrivateFilter := searchStr != "" && strings.Contains(strings.ToLower(searchStr), "private:")
	if !hasExplicitPrivateFilter {
		filters = append(filters, "coalesce(is_private, 0) = 0")
	}

	// Collection filter
	if collectionID != nil {
		filters = append(filters, fmt.Sprintf("collection_id = %d", *collectionID))
	}

	// Parse search string into FTS/SQL conditions
	if searchStr != "" {
		parsedCondition := BuildFilter(searchStr)
		if parsedCondition != "" {
			filters = append(filters, parsedCondition)
		}
	} else {
		limit = true
	}

	// Optional date-range filter
	if dateRange != nil {
		if dateRange.FromDate != "" {
			filters = append(filters, fmt.Sprintf("album_date >= '%s'", dateRange.FromDate))
		}
		if dateRange.ToDate != "" {
			filters = append(filters, fmt.Sprintf("album_date <= '%s'", dateRange.ToDate))
		}
	}

	whereClause := strings.Join(filters, " AND ")

	var sqlQuery string
	if groupByDay {
		// Day grouping: items within a day ordered by captured_at DESC,
		// album_name ASC, filename ASC as tiebreakers.
		limitClause := ""
		if limit {
			limitClause = "LIMIT 365"
		}
		sqlQuery = fmt.Sprintf(`
			WITH t AS (
				SELECT
					album_date AS day,
					%s AS item
				FROM metadata
				WHERE %s
				AND mediatype IN ('image', 'video')
				ORDER BY album_date DESC,
						 coalesce(unixepoch(captured_at), 0) DESC,
						 album_name ASC, filename ASC
			)
			SELECT day, json_group_array(json(item)) AS items
			FROM t
			GROUP BY day
			ORDER BY day DESC
			%s
		`, itemSelect, whereClause, limitClause)
	} else {
		limitClause := ""
		if limit {
			limitClause = "LIMIT 300"
		}
		sqlQuery = fmt.Sprintf(`
			SELECT album_name, %s AS item
			FROM metadata
			WHERE %s
			AND mediatype IN ('image', 'video')
			%s
			%s
		`, itemSelect, whereClause, orderByClause(orderBy), limitClause)
	}

	rows, err := s.db.Query(sqlQuery)
	if err != nil {
		return nil, fmt.Errorf("executing search query: %w", err)
	}
	defer rows.Close()

	if groupByDay {
		return s.scanDayGrouped(rows)
	}
	return s.scanFlat(rows)
}

// scanDayGrouped reads day-grouped query results.
func (s *SearchDB) scanDayGrouped(rows *sql.Rows) ([]DayGroup, error) {
	var results []DayGroup
	for rows.Next() {
		var day string
		var itemsJSON string
		if err := rows.Scan(&day, &itemsJSON); err != nil {
			return nil, fmt.Errorf("scanning day group: %w", err)
		}

		var items []json.RawMessage
		if err := json.Unmarshal([]byte(itemsJSON), &items); err != nil {
			return nil, fmt.Errorf("parsing items JSON for day %s: %w", day, err)
		}

		results = append(results, DayGroup{Day: day, Items: items})
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterating day groups: %w", err)
	}

	if results == nil {
		results = []DayGroup{}
	}
	return results, nil
}

// scanFlat reads flat (non-grouped) query results.
func (s *SearchDB) scanFlat(rows *sql.Rows) ([]FlatResult, error) {
	var results []FlatResult
	for rows.Next() {
		var albumName sql.NullString
		var itemJSON string
		if err := rows.Scan(&albumName, &itemJSON); err != nil {
			return nil, fmt.Errorf("scanning flat result: %w", err)
		}

		album := ""
		if albumName.Valid {
			album = albumName.String
		}

		results = append(results, FlatResult{
			Album: album,
			Item:  json.RawMessage(itemJSON),
		})
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterating flat results: %w", err)
	}

	if results == nil {
		results = []FlatResult{}
	}
	return results, nil
}

// GetItemInfo returns full metadata for a single item by UUID, including face details.
func (s *SearchDB) GetItemInfo(uuid string) (map[string]interface{}, error) {
	query := `
		SELECT
			uuid, album_date, album_name, filename,
			description, filesize, ext, mimetype, mediatype,
			keywords, faces, rating,
			image_width, image_height, duration,
			make, model,
			gps_lat, gps_lng, gps_alt, geo_address,
			captured_at, file_modified_at,
			capture_date, capture_time, capture_tz_offset, capture_tz_name,
			indexed_at, trashed_at,
			(SELECT json_group_array(json_object(
				'face_idx', fr.face_idx,
				'cluster_id', fr.cluster_id,
				'person_name', fr.person_name,
				'confidence', fr.confidence,
				'gender', fr.gender,
				'age', fr.age
			)) FROM face_recognition fr WHERE fr.uuid = metadata.uuid
				AND fr.cluster_id NOT IN (SELECT cluster_id FROM face_dismissed_clusters)
			) AS face_details
		FROM metadata
		WHERE uuid = ?`

	rows, err := s.db.Query(query, uuid)
	if err != nil {
		return nil, fmt.Errorf("querying item info for %s: %w", uuid, err)
	}
	defer rows.Close()

	if !rows.Next() {
		return nil, nil
	}

	// Get column names
	cols, err := rows.Columns()
	if err != nil {
		return nil, fmt.Errorf("getting columns: %w", err)
	}

	// Create a slice of interface{} to hold each column value
	values := make([]interface{}, len(cols))
	valuePtrs := make([]interface{}, len(cols))
	for i := range values {
		valuePtrs[i] = &values[i]
	}

	if err := rows.Scan(valuePtrs...); err != nil {
		return nil, fmt.Errorf("scanning item info: %w", err)
	}

	// Build result map
	result := make(map[string]interface{}, len(cols))
	for i, col := range cols {
		val := values[i]
		// Convert []byte to string for JSON compatibility
		if b, ok := val.([]byte); ok {
			strVal := string(b)
			// Try to parse as JSON if it looks like JSON
			if (strings.HasPrefix(strVal, "[") || strings.HasPrefix(strVal, "{")) {
				var jsonVal interface{}
				if err := json.Unmarshal(b, &jsonVal); err == nil {
					result[col] = jsonVal
					continue
				}
			}
			result[col] = strVal
		} else {
			result[col] = val
		}
	}

	return result, nil
}

// GetGpsCoordinates returns rounded GPS coordinates with item counts for map clustering.
func (s *SearchDB) GetGpsCoordinates(collectionID *int64) ([]map[string]interface{}, error) {
	collectionFilter := ""
	if collectionID != nil {
		collectionFilter = fmt.Sprintf("AND collection_id = %d", *collectionID)
	}

	query := fmt.Sprintf(`
		SELECT
			round(gps_lat, 4) AS lat,
			round(gps_lng, 4) AS lng,
			count(*) AS count
		FROM metadata
		WHERE gps_lat IS NOT NULL
		AND gps_lng IS NOT NULL
		AND coalesce(is_trashed, 0) = 0
		AND coalesce(is_private, 0) = 0
		AND mediatype IN ('image', 'video')
		%s
		GROUP BY 1, 2
	`, collectionFilter)

	rows, err := s.db.Query(query)
	if err != nil {
		return nil, fmt.Errorf("querying GPS coordinates: %w", err)
	}
	defer rows.Close()

	var results []map[string]interface{}
	for rows.Next() {
		var lat, lng float64
		var count int64
		if err := rows.Scan(&lat, &lng, &count); err != nil {
			return nil, fmt.Errorf("scanning GPS coordinate: %w", err)
		}
		results = append(results, map[string]interface{}{
			"lat":   lat,
			"lng":   lng,
			"count": count,
		})
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterating GPS coordinates: %w", err)
	}

	if results == nil {
		results = []map[string]interface{}{}
	}
	return results, nil
}

// SearchByGps searches for items within GPS bounding box coordinates.
func (s *SearchDB) SearchByGps(collectionID *int64, swLat, swLng, neLat, neLng float64) (interface{}, error) {
	searchStr := fmt.Sprintf(`raw:"round(gps_lat, 4) between %f and %f and round(gps_lng, 4) between %f and %f"`, swLat, neLat, swLng, neLng)
	return s.RunSearch(collectionID, searchStr, false, true, "", nil)
}

// orderByClause returns the ORDER BY clause for flat (non-grouped) queries.
func orderByClause(inp string) string {
	defaultClause := "ORDER BY album_date DESC, datetime(captured_at) DESC"
	if inp == "" {
		return defaultClause
	}

	switch strings.ToLower(inp) {
	case "asc":
		return "ORDER BY datetime(captured_at) ASC"
	case "desc":
		return "ORDER BY datetime(captured_at) DESC"
	case "random":
		return "ORDER BY random()"
	default:
		return defaultClause
	}
}
