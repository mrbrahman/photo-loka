package database

import (
	"database/sql"
	"embed"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"

	"github.com/mattn/go-sqlite3"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Register custom SQLite driver with extensions (once at init)
var registerOnce sync.Once

func registerDriver() {
	registerOnce.Do(func() {
		sql.Register("sqlite3_photo_loka", &sqlite3.SQLiteDriver{
			ConnectHook: func(conn *sqlite3.SQLiteConn) error {
				// json_patch_agg: merges multiple JSON objects into one (like json_patch).
				// Used by getPendingExifUpdates to combine all pending exif changes for a file.
				// NOTE: Currently unused because the exif write-back job is not implemented.
				return conn.RegisterAggregator("json_patch_agg", newJsonPatchAgg, true)
			},
		})
	})
}

// jsonPatchAgg implements a custom SQLite aggregate that merges JSON objects.
type jsonPatchAgg struct {
	result map[string]interface{}
}

func newJsonPatchAgg() *jsonPatchAgg {
	return &jsonPatchAgg{result: make(map[string]interface{})}
}

func (a *jsonPatchAgg) Step(input string) {
	var patch map[string]interface{}
	if json.Unmarshal([]byte(input), &patch) == nil {
		for k, v := range patch {
			a.result[k] = v
		}
	}
}

func (a *jsonPatchAgg) Done() string {
	b, _ := json.Marshal(a.result)
	return string(b)
}

// DB wraps a *sql.DB connection to SQLite.
type DB struct {
	Conn *sql.DB
}

// Open opens the SQLite database, creates parent directories if needed, and runs migrations.
func Open(dbFile string) (*DB, error) {
	// Register custom driver with aggregate functions
	registerDriver()

	// Create parent directory if it doesn't exist
	dir := filepath.Dir(dbFile)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("creating database directory: %w", err)
	}

	dsn := fmt.Sprintf("file:%s?_journal_mode=WAL&_busy_timeout=5000&_synchronous=NORMAL", dbFile)
	conn, err := sql.Open("sqlite3_photo_loka", dsn)
	if err != nil {
		return nil, fmt.Errorf("opening database: %w", err)
	}

	// Verify connection
	if err := conn.Ping(); err != nil {
		conn.Close()
		return nil, fmt.Errorf("pinging database: %w", err)
	}

	db := &DB{Conn: conn}

	if err := db.runMigrations(); err != nil {
		conn.Close()
		return nil, fmt.Errorf("running migrations: %w", err)
	}

	return db, nil
}

// Close closes the database connection.
func (d *DB) Close() error {
	return d.Conn.Close()
}

// runMigrations applies pending migrations based on PRAGMA user_version.
func (d *DB) runMigrations() error {
	var currentVersion int
	err := d.Conn.QueryRow("PRAGMA user_version").Scan(&currentVersion)
	if err != nil {
		return fmt.Errorf("reading user_version: %w", err)
	}

	type migration struct {
		version  int
		filename string
	}

	migrations := []migration{
		{version: 10, filename: "migrations/010-initial-schema.sql"},
		{version: 11, filename: "migrations/011-geo-lookups.sql"},
		{version: 12, filename: "migrations/012-capture-time-columns.sql"},
	}

	for _, m := range migrations {
		if currentVersion < m.version {
			slog.Info("running migration", "file", m.filename, "version", m.version)

			sqlBytes, err := migrationsFS.ReadFile(m.filename)
			if err != nil {
				return fmt.Errorf("reading migration %s: %w", m.filename, err)
			}

			tx, err := d.Conn.Begin()
			if err != nil {
				return fmt.Errorf("beginning transaction for %s: %w", m.filename, err)
			}

			if _, err := tx.Exec(string(sqlBytes)); err != nil {
				tx.Rollback()
				return fmt.Errorf("executing migration %s: %w", m.filename, err)
			}

			// PRAGMA user_version cannot be set inside a transaction in SQLite,
			// so we commit first, then set it.
			if err := tx.Commit(); err != nil {
				return fmt.Errorf("committing migration %s: %w", m.filename, err)
			}

			if _, err := d.Conn.Exec(fmt.Sprintf("PRAGMA user_version = %d", m.version)); err != nil {
				return fmt.Errorf("setting user_version to %d: %w", m.version, err)
			}

			currentVersion = m.version
		}
	}

	return nil
}
