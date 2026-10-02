package pipeline

import (
	"path/filepath"
	"testing"

	"photo-loka/internal/database"
)

// TestMigrationsSeedValidPipelineConfig runs the real migrations against a fresh
// temp DB and asserts the seeded+migrated pipelineConfig row parses, validates
// (strictly: exactly the fixed stage set), and carries the expected default
// gate graph. Because validation requires every allStages entry exactly once, a
// successful parse already proves migration 015 produced the geo chain
// (geo-cache/geo-lookup-addr/geo-lookup-city) and renamed the old geo-lookup;
// we assert those explicitly too. Guards against a broken seed/migration.
func TestMigrationsSeedValidPipelineConfig(t *testing.T) {
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
		t.Fatalf("seeded+migrated pipelineConfig failed to parse/validate: %v", err)
	}
	byName := cfg.byName()

	// Migration 015: geo chain present, old geo-lookup gone.
	for _, name := range []string{StageGeoCache, StageGeoAddr, StageGeoCity} {
		if _, ok := byName[name]; !ok {
			t.Errorf("migrated config missing geo stage %q", name)
		}
	}
	if _, ok := byName["geo-lookup"]; ok {
		t.Errorf("migrated config should no longer contain the old geo-lookup stage")
	}

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
