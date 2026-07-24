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

// SaveFaceResults deletes old face data for a uuid, inserts new faces and unmatched entries,
// and updates the metadata.faces field.
func (m *MLDB) SaveFaceResults(uuid string, faces []map[string]interface{}, unmatched []map[string]interface{}) error {
	tx, err := m.db.Begin()
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	// Delete old face records for this uuid
	if _, err := tx.Exec(`DELETE FROM face_recognition WHERE uuid = ?`, uuid); err != nil {
		return fmt.Errorf("failed to delete old face records: %w", err)
	}

	// Insert matched faces
	for _, face := range faces {
		clusterID, _ := face["cluster_id"].(string)
		name, _ := face["name"].(string)
		confidence, _ := face["confidence"].(float64)
		bbox, _ := json.Marshal(face["bbox"])

		_, err := tx.Exec(
			`INSERT INTO face_recognition (uuid, cluster_id, name, confidence, bbox, status)
			 VALUES (?, ?, ?, ?, ?, 'matched')`,
			uuid, clusterID, name, confidence, string(bbox),
		)
		if err != nil {
			return fmt.Errorf("failed to insert face record: %w", err)
		}
	}

	// Insert unmatched faces
	for _, face := range unmatched {
		clusterID, _ := face["cluster_id"].(string)
		confidence, _ := face["confidence"].(float64)
		bbox, _ := json.Marshal(face["bbox"])

		_, err := tx.Exec(
			`INSERT INTO face_recognition (uuid, cluster_id, name, confidence, bbox, status)
			 VALUES (?, ?, NULL, ?, ?, 'unmatched')`,
			uuid, clusterID, confidence, string(bbox),
		)
		if err != nil {
			return fmt.Errorf("failed to insert unmatched face record: %w", err)
		}
	}

	// Update metadata.faces with the names of recognized faces
	var faceNames []string
	for _, face := range faces {
		if name, ok := face["name"].(string); ok && name != "" {
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
		`SELECT cluster_id, name, confidence, bbox, status
		 FROM face_recognition WHERE uuid = ?`,
		uuid,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []map[string]interface{}
	for rows.Next() {
		var clusterID string
		var name sql.NullString
		var confidence float64
		var bboxStr string
		var status string

		if err := rows.Scan(&clusterID, &name, &confidence, &bboxStr, &status); err != nil {
			return nil, err
		}

		face := map[string]interface{}{
			"cluster_id": clusterID,
			"confidence": confidence,
			"status":     status,
		}

		if name.Valid {
			face["name"] = name.String
		}

		var bbox interface{}
		if json.Unmarshal([]byte(bboxStr), &bbox) == nil {
			face["bbox"] = bbox
		}

		results = append(results, face)
	}

	return results, rows.Err()
}

// GetFacesByPerson returns all face records for a given person name.
func (m *MLDB) GetFacesByPerson(name string) ([]map[string]interface{}, error) {
	rows, err := m.db.Query(
		`SELECT fr.uuid, fr.cluster_id, fr.confidence, fr.bbox
		 FROM face_recognition fr
		 WHERE fr.name = ?`,
		name,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []map[string]interface{}
	for rows.Next() {
		var uuid, clusterID, bboxStr string
		var confidence float64

		if err := rows.Scan(&uuid, &clusterID, &confidence, &bboxStr); err != nil {
			return nil, err
		}

		face := map[string]interface{}{
			"uuid":       uuid,
			"cluster_id": clusterID,
			"confidence": confidence,
		}

		var bbox interface{}
		if json.Unmarshal([]byte(bboxStr), &bbox) == nil {
			face["bbox"] = bbox
		}

		results = append(results, face)
	}

	return results, rows.Err()
}

// NameFaceCluster assigns a name to all face records with a given cluster_id.
// Returns the number of rows affected.
func (m *MLDB) NameFaceCluster(clusterID, name string) (int64, error) {
	tx, err := m.db.Begin()
	if err != nil {
		return 0, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	// Update face_recognition table
	result, err := tx.Exec(
		`UPDATE face_recognition SET name = ?, status = 'matched' WHERE cluster_id = ?`,
		name, clusterID,
	)
	if err != nil {
		return 0, fmt.Errorf("failed to update face_recognition: %w", err)
	}

	rowsAffected, _ := result.RowsAffected()

	// Update metadata.faces for all affected UUIDs
	rows, err := tx.Query(`SELECT DISTINCT uuid FROM face_recognition WHERE cluster_id = ?`, clusterID)
	if err != nil {
		return 0, fmt.Errorf("failed to query affected uuids: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var uuid string
		if err := rows.Scan(&uuid); err != nil {
			return 0, err
		}
		if err := m.updateMetadataFaces(tx, uuid); err != nil {
			return 0, err
		}
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

	// Update face_recognition table
	result, err := tx.Exec(
		`UPDATE face_recognition SET name = ? WHERE name = ?`,
		newName, oldName,
	)
	if err != nil {
		return 0, fmt.Errorf("failed to update face_recognition: %w", err)
	}

	rowsAffected, _ := result.RowsAffected()

	// Update metadata.faces for all affected UUIDs
	rows, err := tx.Query(`SELECT DISTINCT uuid FROM face_recognition WHERE name = ?`, newName)
	if err != nil {
		return 0, fmt.Errorf("failed to query affected uuids: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var uuid string
		if err := rows.Scan(&uuid); err != nil {
			return 0, err
		}
		if err := m.updateMetadataFaces(tx, uuid); err != nil {
			return 0, err
		}
	}

	if err := tx.Commit(); err != nil {
		return 0, err
	}

	return rowsAffected, nil
}

// SearchPersonNames searches for person names matching the query string (LIKE).
// Returns up to 20 results.
func (m *MLDB) SearchPersonNames(query string) ([]string, error) {
	rows, err := m.db.Query(
		`SELECT DISTINCT name FROM face_recognition
		 WHERE name IS NOT NULL AND name LIKE ?
		 ORDER BY name
		 LIMIT 20`,
		"%"+query+"%",
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

// DismissCluster marks a face cluster as dismissed.
func (m *MLDB) DismissCluster(clusterID string) error {
	_, err := m.db.Exec(
		`UPDATE face_recognition SET status = 'dismissed' WHERE cluster_id = ?`,
		clusterID,
	)
	return err
}

// UndismissCluster marks a dismissed face cluster back to unmatched.
func (m *MLDB) UndismissCluster(clusterID string) error {
	_, err := m.db.Exec(
		`UPDATE face_recognition SET status = 'unmatched' WHERE cluster_id = ? AND status = 'dismissed'`,
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
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		clusterIDs = append(clusterIDs, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Delete face records
	if _, err := m.db.Exec(`DELETE FROM face_recognition WHERE uuid = ?`, uuid); err != nil {
		return nil, err
	}

	// Clear metadata.faces
	if _, err := m.db.Exec(`UPDATE metadata SET faces = NULL WHERE uuid = ?`, uuid); err != nil {
		return nil, err
	}

	return clusterIDs, nil
}

// updateMetadataFaces rebuilds the metadata.faces JSON array for a uuid
// from current face_recognition records.
func (m *MLDB) updateMetadataFaces(tx *sql.Tx, uuid string) error {
	rows, err := tx.Query(
		`SELECT name FROM face_recognition WHERE uuid = ? AND name IS NOT NULL AND status = 'matched'`,
		uuid,
	)
	if err != nil {
		return err
	}
	defer rows.Close()

	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return err
		}
		names = append(names, name)
	}
	if err := rows.Err(); err != nil {
		return err
	}

	facesJSON, _ := json.Marshal(names)
	_, err = tx.Exec(`UPDATE metadata SET faces = ? WHERE uuid = ?`, string(facesJSON), uuid)
	return err
}
