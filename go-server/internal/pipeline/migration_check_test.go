package pipeline

import (
	"path/filepath"
	"testing"

	"photo-loka/internal/database"
)

// TestMigration014SeedsValidConfig runs the real migrations against a fresh temp
// DB and asserts the seeded pipelineConfig row parses, validates, and carries
// the expected default gate graph, that image-encoding is enabled, and that
// performFaceRecognition was removed. Guards against a broken seed JSON (which
// would otherwise fall back to the default silently at startup).
func TestMigration014SeedsValidConfig(t *testing.T) {
	dbFile := filepath.Join(t.TempDir(), "test.sqlite")
	if err := database.Open(dbFile); err != nil {
		t.Fatalf("opening db / running migrations: %v", err)
	}
	defer database.Close()

	var raw string
	if err := database.DB.QueryRow(
		"SELECT value FROM runtime_config WHERE key = 'pipelineConfig'",
	).Scan(&raw); err != nil {
		t.Fatalf("pipelineConfig row missing after migration: %v", err)
	}

	cfg, err := ParsePipelineConfig(raw)
	if err != nil {
		t.Fatalf("seeded pipelineConfig failed to parse/validate: %v", err)
	}
	byName := cfg.byName()
	if got := byName[StageVideoCompression].GatedBy; !equal(got,
		[]string{StageImageThumbnails, StageFaceRecognition, StageImageEncoding}) {
		t.Errorf("seeded video-compression gatedBy = %v", got)
	}
	if byName[StageImageEncoding].Enabled == nil || !*byName[StageImageEncoding].Enabled {
		t.Errorf("seeded image-encoding should be enabled")
	}

	var n int
	if err := database.DB.QueryRow(
		"SELECT COUNT(*) FROM runtime_config WHERE key = 'performFaceRecognition'",
	).Scan(&n); err != nil {
		t.Fatalf("count query: %v", err)
	}
	if n != 0 {
		t.Errorf("performFaceRecognition row should have been removed by migration 014")
	}

	// persistStageConcurrency round-trip: update one stage's concurrency and
	// confirm it survives a reload of the stored config (the endpoint's
	// persistence path).
	if err := persistStageConcurrency(StageFaceRecognition, 7); err != nil {
		t.Fatalf("persistStageConcurrency: %v", err)
	}
	reloaded := loadConfig()
	if got := reloaded.byName()[StageFaceRecognition].concurrency(); got != 7 {
		t.Errorf("persisted face-recognition concurrency = %d, want 7", got)
	}
	// Other stages untouched (gate graph preserved).
	if got := reloaded.byName()[StageVideoCompression].GatedBy; !equal(got,
		[]string{StageImageThumbnails, StageFaceRecognition, StageImageEncoding}) {
		t.Errorf("persist should not disturb gate graph; got %v", got)
	}
}
