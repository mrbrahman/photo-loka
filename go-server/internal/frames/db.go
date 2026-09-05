package frames

import (
	"database/sql"
	"fmt"
)

// FramesDB provides database operations for frame records.
type FramesDB struct {
	db *sql.DB
}

// Frame represents a digital photo frame configuration stored in the database.
type Frame struct {
	FrameID         int64   `json:"frame_id"`
	FrameIPAddr     string  `json:"frame_ip_addr"`
	FrameName       string  `json:"frame_name"`
	CollectionID    *int64  `json:"collection_id"`
	SearchStr       string  `json:"search_str"`
	DisplayOrder    *string `json:"display_order"`
	DailyPauseRange *string `json:"daily_pause_range"`
	ResetSchedule   *string `json:"reset_schedule"`
}

// NewFramesDB creates a new FramesDB instance.
func NewFramesDB(conn *sql.DB) *FramesDB {
	return &FramesDB{db: conn}
}

// Create inserts a new frame and returns the new frame_id.
func (f *FramesDB) Create(frame *Frame) (int64, error) {
	query := `
		INSERT INTO frames (
			frame_ip_addr, frame_name, collection_id, search_str,
			display_order, daily_pause_range, reset_schedule
		) VALUES (?, ?, ?, ?, ?, ?, ?)`

	result, err := f.db.Exec(query,
		frame.FrameIPAddr,
		frame.FrameName,
		frame.CollectionID,
		frame.SearchStr,
		frame.DisplayOrder,
		frame.DailyPauseRange,
		frame.ResetSchedule,
	)
	if err != nil {
		return 0, fmt.Errorf("inserting frame: %w", err)
	}

	id, err := result.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("getting last insert id: %w", err)
	}

	return id, nil
}

// GetAll returns all frame records.
func (f *FramesDB) GetAll() ([]Frame, error) {
	query := `
		SELECT frame_id, frame_ip_addr, frame_name, collection_id,
			   search_str, display_order, daily_pause_range, reset_schedule
		FROM frames`

	rows, err := f.db.Query(query)
	if err != nil {
		return nil, fmt.Errorf("querying frames: %w", err)
	}
	defer rows.Close()

	var results []Frame
	for rows.Next() {
		var frame Frame
		if err := rows.Scan(
			&frame.FrameID,
			&frame.FrameIPAddr,
			&frame.FrameName,
			&frame.CollectionID,
			&frame.SearchStr,
			&frame.DisplayOrder,
			&frame.DailyPauseRange,
			&frame.ResetSchedule,
		); err != nil {
			return nil, fmt.Errorf("scanning frame: %w", err)
		}
		results = append(results, frame)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterating frames: %w", err)
	}

	if results == nil {
		results = []Frame{}
	}
	return results, nil
}

// GetByID returns a single frame by ID.
func (f *FramesDB) GetByID(frameID int64) (*Frame, error) {
	query := `
		SELECT frame_id, frame_ip_addr, frame_name, collection_id,
			   search_str, display_order, daily_pause_range, reset_schedule
		FROM frames
		WHERE frame_id = ?`

	frame := &Frame{}
	err := f.db.QueryRow(query, frameID).Scan(
		&frame.FrameID,
		&frame.FrameIPAddr,
		&frame.FrameName,
		&frame.CollectionID,
		&frame.SearchStr,
		&frame.DisplayOrder,
		&frame.DailyPauseRange,
		&frame.ResetSchedule,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("querying frame %d: %w", frameID, err)
	}

	return frame, nil
}

// Update updates an existing frame by ID.
func (f *FramesDB) Update(frameID int64, frame *Frame) error {
	query := `
		UPDATE frames SET
			frame_ip_addr = ?,
			frame_name = ?,
			collection_id = ?,
			search_str = ?,
			display_order = ?,
			daily_pause_range = ?,
			reset_schedule = ?
		WHERE frame_id = ?`

	result, err := f.db.Exec(query,
		frame.FrameIPAddr,
		frame.FrameName,
		frame.CollectionID,
		frame.SearchStr,
		frame.DisplayOrder,
		frame.DailyPauseRange,
		frame.ResetSchedule,
		frameID,
	)
	if err != nil {
		return fmt.Errorf("updating frame %d: %w", frameID, err)
	}

	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("checking rows affected: %w", err)
	}
	if rows == 0 {
		return fmt.Errorf("frame %d not found", frameID)
	}

	return nil
}

// Delete removes a frame by ID.
func (f *FramesDB) Delete(frameID int64) error {
	result, err := f.db.Exec("DELETE FROM frames WHERE frame_id = ?", frameID)
	if err != nil {
		return fmt.Errorf("deleting frame %d: %w", frameID, err)
	}

	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("checking rows affected: %w", err)
	}
	if rows == 0 {
		return fmt.Errorf("frame %d not found", frameID)
	}

	return nil
}
