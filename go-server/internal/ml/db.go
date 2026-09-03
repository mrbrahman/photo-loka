package ml

import (
	"database/sql"
	"encoding/json"
	"fmt"
)

// MLDB handles database operations for face recognition.
type MLDB struct {
	db *sql.DB
}

// NewMLDB creates a new MLDB instance.
func NewMLDB(conn *sql.DB) *MLDB {
	return &MLDB{db: conn}
}

// jsonOrNull returns a JSON string or nil if the value is nil.
func jsonOrNull(val interface{}) interface{} {
	if val == nil {
		return nil
	}
	b, err := json.Marshal(val)
	if err != nil {
		return nil
	}
	return string(b)
}

// intOrNull converts a bool-like value to 1/0/nil for INTEGER columns.
func intOrNull(val interface{}) interface{} {
	if val == nil {
		return nil
	}
	switch v := val.(type) {
	case bool:
		if v {
			return 1
		}
		return 0
	case float64:
		return int(v)
	}
	return nil
}

// ItemForRecognition holds the fields needed to call the ML face recognition service.
type ItemForRecognition struct {
	Filename    string
	Orientation int
	Xmpregion   *string
}

// GetItemForRecognition retrieves the filename, orientation, and xmpregion for a uuid.
func (m *MLDB) GetItemForRecognition(uuid string) (*ItemForRecognition, error) {
	item := &ItemForRecognition{}
	var xmpregion sql.NullString
	err := m.db.QueryRow(
		`SELECT filename, COALESCE(orientation, 1), xmpregion FROM metadata WHERE uuid = ?`,
		uuid,
	).Scan(&item.Filename, &item.Orientation, &xmpregion)
	if err != nil {
		return nil, fmt.Errorf("getting item for recognition %s: %w", uuid, err)
	}
	if xmpregion.Valid {
		item.Xmpregion = &xmpregion.String
	}
	return item, nil
}

// SaveFaceResults deletes old face data for a uuid, inserts new faces and unmatched entries,
// and updates the metadata.faces field.
func (m *MLDB) SaveFaceResults(uuid string, faces []map[string]interface{}, unmatched []map[string]interface{}) error {
	tx, err := m.db.Begin()
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	// Delete old records for this uuid
	if _, err := tx.Exec(`DELETE FROM face_recognition WHERE uuid = ?`, uuid); err != nil {
		return fmt.Errorf("failed to delete old face records: %w", err)
	}
	if _, err := tx.Exec(`DELETE FROM face_recognition_unmatched WHERE uuid = ?`, uuid); err != nil {
		return fmt.Errorf("failed to delete old unmatched records: %w", err)
	}

	// Insert detected faces
	for i, f := range faces {
		cluster, _ := f["cluster"].(map[string]interface{})
		inputMatch, _ := f["input_face_match"].(map[string]interface{})

		_, err := tx.Exec(`
			INSERT INTO face_recognition (
				uuid, face_idx, person_name, gender, age, confidence,
				bbox, landmarks, pose,
				cluster_id, cluster_name, cluster_confidence,
				cluster_consensus_count, cluster_reference_image_ids,
				cluster_is_new, cluster_centroid,
				input_face_matched, input_face_name, input_face_confidence,
				input_face_match_strategy, input_face_bbox, input_face_centroid,
				name_mismatch
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			uuid,
			i,
			f["person_name"],
			f["gender"],
			f["age"],
			f["confidence"],
			jsonOrNull(f["bbox"]),
			jsonOrNull(f["landmarks"]),
			jsonOrNull(f["pose"]),
			cluster["cluster_id"],
			cluster["name"],
			cluster["confidence"],
			cluster["consensus_count"],
			jsonOrNull(cluster["reference_image_ids"]),
			intOrNull(cluster["is_new_cluster"]),
			jsonOrNull(cluster["centroid"]),
			intOrNull(inputMatch["matched"]),
			inputMatch["name"],
			inputMatch["confidence"],
			inputMatch["match_strategy"],
			jsonOrNull(inputMatch["input_bbox"]),
			jsonOrNull(inputMatch["centroid"]),
			intOrNull(f["name_mismatch"]),
		)
		if err != nil {
			return fmt.Errorf("failed to insert face record %d: %w", i, err)
		}
	}

	// Insert unmatched input faces
	for i, u := range unmatched {
		_, err := tx.Exec(`
			INSERT INTO face_recognition_unmatched (uuid, face_idx, name, x, y, w, h, centroid)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			uuid, i, u["name"], u["x"], u["y"], u["w"], u["h"], jsonOrNull(u["centroid"]),
		)
		if err != nil {
			return fmt.Errorf("failed to insert unmatched face record %d: %w", i, err)
		}
	}

	// Update metadata.faces with recognized person names. This column is a
	// summary of *named* people; detected-but-unnamed faces contribute no name
	// (their detail is preserved in face_recognition). Initialize as a non-nil
	// slice so that "ML ran, no recognized names" serializes to [] (known)
	// rather than null (nothing known / ML not run).
	faceNames := []string{}
	for _, face := range faces {
		if name, ok := face["person_name"].(string); ok && name != "" {
			faceNames = append(faceNames, name)
		}
	}
	facesJSON, _ := json.Marshal(faceNames)
	if _, err := tx.Exec(`UPDATE metadata SET faces = ? WHERE uuid = ?`, string(facesJSON), uuid); err != nil {
		return fmt.Errorf("failed to update metadata.faces: %w", err)
	}

	return tx.Commit()
}

// GetFacesByUUID returns all face records for a given uuid.
func (m *MLDB) GetFacesByUUID(uuid string) ([]map[string]interface{}, error) {
	rows, err := m.db.Query(
		`SELECT uuid, face_idx, person_name, gender, age, confidence, bbox,
				landmarks, pose, cluster_id, cluster_name, cluster_confidence,
				cluster_consensus_count, cluster_reference_image_ids, cluster_is_new,
				cluster_centroid, input_face_matched, input_face_name,
				input_face_confidence, input_face_match_strategy, input_face_bbox,
				input_face_centroid, name_mismatch, created_at
		 FROM face_recognition
		 WHERE uuid = ?
		 ORDER BY face_idx`,
		uuid,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	return scanRowsToMaps(rows)
}

// GetFacesByPerson returns all face records for a given person name.
func (m *MLDB) GetFacesByPerson(name string) ([]map[string]interface{}, error) {
	rows, err := m.db.Query(
		`SELECT uuid, face_idx, person_name, gender, age, confidence, bbox,
				landmarks, pose, cluster_id, cluster_name, cluster_confidence,
				cluster_consensus_count, cluster_reference_image_ids, cluster_is_new,
				cluster_centroid, input_face_matched, input_face_name,
				input_face_confidence, input_face_match_strategy, input_face_bbox,
				input_face_centroid, name_mismatch, created_at
		 FROM face_recognition
		 WHERE person_name = ?`,
		name,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	return scanRowsToMaps(rows)
}
// NameFaceCluster assigns a person_name to all face records with a given cluster_id.
// Also updates cluster_name on the records. Returns the number of rows affected.
func (m *MLDB) NameFaceCluster(clusterID, name string) (int64, error) {
	tx, err := m.db.Begin()
	if err != nil {
		return 0, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	// Update face_recognition: set person_name
	result, err := tx.Exec(
		`UPDATE face_recognition SET person_name = ? WHERE cluster_id = ?`,
		name, clusterID,
	)
	if err != nil {
		return 0, fmt.Errorf("failed to update face_recognition: %w", err)
	}
	rowsAffected, _ := result.RowsAffected()

	// Update metadata.faces for all affected UUIDs
	if _, err := tx.Exec(`
		UPDATE metadata SET faces = (
			SELECT json_group_array(person_name)
			FROM face_recognition
			WHERE uuid = metadata.uuid AND person_name IS NOT NULL
		) WHERE uuid IN (SELECT DISTINCT uuid FROM face_recognition WHERE cluster_id = ?)
	`, clusterID); err != nil {
		return 0, fmt.Errorf("failed to update metadata.faces: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return 0, err
	}

	return rowsAffected, nil
}

// UpdatePersonName renames a person across all face records.
// Returns the number of rows affected.
func (m *MLDB) UpdatePersonName(oldName, newName string) (int64, error) {
	tx, err := m.db.Begin()
	if err != nil {
		return 0, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	// Update face_recognition
	result, err := tx.Exec(
		`UPDATE face_recognition SET person_name = ? WHERE person_name = ?`,
		newName, oldName,
	)
	if err != nil {
		return 0, fmt.Errorf("failed to update face_recognition: %w", err)
	}
	rowsAffected, _ := result.RowsAffected()

	// Update metadata.faces for all affected UUIDs
	if _, err := tx.Exec(`
		UPDATE metadata SET faces = (
			SELECT json_group_array(person_name)
			FROM face_recognition
			WHERE uuid = metadata.uuid AND person_name IS NOT NULL
		) WHERE uuid IN (SELECT DISTINCT uuid FROM face_recognition WHERE person_name = ?)
	`, newName); err != nil {
		return 0, fmt.Errorf("failed to update metadata.faces: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return 0, err
	}

	return rowsAffected, nil
}

// SearchPersonNames searches for person names matching the query (prefix LIKE).
// Returns up to 20 results.
func (m *MLDB) SearchPersonNames(query string) ([]string, error) {
	rows, err := m.db.Query(
		`SELECT DISTINCT person_name FROM face_recognition
		 WHERE person_name IS NOT NULL AND person_name LIKE ? || '%'
		 ORDER BY person_name
		 LIMIT 20`,
		query,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		names = append(names, name)
	}

	return names, rows.Err()
}

// DismissCluster inserts a cluster_id into the face_dismissed_clusters table.
func (m *MLDB) DismissCluster(clusterID string) error {
	_, err := m.db.Exec(
		`INSERT OR IGNORE INTO face_dismissed_clusters (cluster_id) VALUES (?)`,
		clusterID,
	)
	return err
}

// UndismissCluster removes a cluster_id from the face_dismissed_clusters table.
func (m *MLDB) UndismissCluster(clusterID string) error {
	_, err := m.db.Exec(
		`DELETE FROM face_dismissed_clusters WHERE cluster_id = ?`,
		clusterID,
	)
	return err
}

// DeleteFaceData removes all face records for a uuid and returns the affected cluster_ids
// for thumbnail cleanup.
func (m *MLDB) DeleteFaceData(uuid string) ([]string, error) {
	// Get cluster_ids before deletion
	rows, err := m.db.Query(
		`SELECT DISTINCT cluster_id FROM face_recognition WHERE uuid = ?`,
		uuid,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var clusterIDs []string
	for rows.Next() {
		var id sql.NullString
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		if id.Valid {
			clusterIDs = append(clusterIDs, id.String)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Delete face records
	if _, err := m.db.Exec(`DELETE FROM face_recognition WHERE uuid = ?`, uuid); err != nil {
		return nil, err
	}
	// Delete unmatched records
	if _, err := m.db.Exec(`DELETE FROM face_recognition_unmatched WHERE uuid = ?`, uuid); err != nil {
		return nil, err
	}

	// Clear metadata.faces
	if _, err := m.db.Exec(`UPDATE metadata SET faces = NULL WHERE uuid = ?`, uuid); err != nil {
		return nil, err
	}

	return clusterIDs, nil
}

// Helper functions for nullable types

func nullStr(ns sql.NullString) interface{} {
	if ns.Valid {
		return ns.String
	}
	return nil
}

func nullFloat(nf sql.NullFloat64) interface{} {
	if nf.Valid {
		return nf.Float64
	}
	return nil
}

// scanRowsToMaps converts SQL rows into a slice of maps with column names as keys.
func scanRowsToMaps(rows *sql.Rows) ([]map[string]interface{}, error) {
	columns, err := rows.Columns()
	if err != nil {
		return nil, err
	}

	var results []map[string]interface{}
	for rows.Next() {
		values := make([]interface{}, len(columns))
		valuePtrs := make([]interface{}, len(columns))
		for i := range values {
			valuePtrs[i] = &values[i]
		}

		if err := rows.Scan(valuePtrs...); err != nil {
			return nil, err
		}

		row := make(map[string]interface{}, len(columns))
		for i, col := range columns {
			val := values[i]
			// Convert []byte to string for readability
			if b, ok := val.([]byte); ok {
				row[col] = string(b)
			} else {
				row[col] = val
			}
		}
		results = append(results, row)
	}

	if results == nil {
		results = []map[string]interface{}{}
	}

	return results, rows.Err()
}
