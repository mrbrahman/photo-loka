package pipeline

import (
	"strings"
	"testing"
)

func TestDefaultConfigValidates(t *testing.T) {
	if err := DefaultPipelineConfig().Validate(); err != nil {
		t.Fatalf("default config should validate: %v", err)
	}
}

func TestDefaultConfigGateGraph(t *testing.T) {
	// The default gate graph the design agreed on: heavy stages gated on image
	// thumbnails, then serialized face -> encode -> compress.
	byName := DefaultPipelineConfig().byName()
	wants := map[string][]string{
		StageFaceRecognition:  {StageImageThumbnails},
		StageImageEncoding:    {StageImageThumbnails, StageFaceRecognition},
		StageVideoCompression: {StageImageThumbnails, StageFaceRecognition, StageImageEncoding},
	}
	for stage, want := range wants {
		got := byName[stage].GatedBy
		if !equal(got, want) {
			t.Errorf("%s gatedBy = %v, want %v", stage, got, want)
		}
	}
	// Light stages ungated.
	for _, s := range []string{StageBringToCollection, StageGeoLookup, StageVideoThumbnail, StageImageThumbnails} {
		if len(byName[s].GatedBy) != 0 {
			t.Errorf("%s should be ungated, got %v", s, byName[s].GatedBy)
		}
	}
}

func TestParse_EmptyReturnsDefault(t *testing.T) {
	cfg, err := ParsePipelineConfig("")
	if err != nil {
		t.Fatalf("empty parse err: %v", err)
	}
	if len(cfg.Stages) != len(allStages) {
		t.Errorf("empty parse should yield default (%d stages), got %d", len(allStages), len(cfg.Stages))
	}
}

func TestValidate_RejectsCycle(t *testing.T) {
	// face -> encode -> face is a cycle.
	cfg := DefaultPipelineConfig()
	m := cfg.byName()
	m[StageFaceRecognition] = StageConfig{Name: StageFaceRecognition, GatedBy: []string{StageImageEncoding}}
	m[StageImageEncoding] = StageConfig{Name: StageImageEncoding, GatedBy: []string{StageFaceRecognition}}
	// rebuild slice from map
	var stages []StageConfig
	for _, n := range allStages {
		stages = append(stages, m[n])
	}
	err := PipelineConfig{Stages: stages}.Validate()
	if err == nil || !strings.Contains(err.Error(), "cycle") {
		t.Fatalf("expected cycle error, got %v", err)
	}
}

func TestValidate_RejectsDisablingStructural(t *testing.T) {
	for _, structural := range []string{StageBringToCollection, StageImageThumbnails, StageVideoThumbnail} {
		cfg := DefaultPipelineConfig()
		for i := range cfg.Stages {
			if cfg.Stages[i].Name == structural {
				f := false
				cfg.Stages[i].Enabled = &f
			}
		}
		err := cfg.Validate()
		if err == nil || !strings.Contains(err.Error(), "structural") {
			t.Errorf("disabling %q should be rejected, got %v", structural, err)
		}
	}
}

func TestValidate_RejectsUnknownGatedBy(t *testing.T) {
	cfg := DefaultPipelineConfig()
	cfg.Stages[4].GatedBy = []string{"no-such-stage"}
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "unknown stage") {
		t.Fatalf("expected unknown-stage error, got %v", err)
	}
}

func TestValidate_RejectsMissingStage(t *testing.T) {
	cfg := DefaultPipelineConfig()
	cfg.Stages = cfg.Stages[:len(cfg.Stages)-1] // drop one
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "missing") {
		t.Fatalf("expected missing-stage error, got %v", err)
	}
}

func TestValidate_RejectsDuplicateStage(t *testing.T) {
	cfg := DefaultPipelineConfig()
	cfg.Stages = append(cfg.Stages, StageConfig{Name: StageGeoLookup})
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "more than once") {
		t.Fatalf("expected duplicate-stage error, got %v", err)
	}
}

func TestBuildStages_AppliesConfig(t *testing.T) {
	// Concurrency, enable, and gatedBy from config land on the Stage structs.
	cfg := DefaultPipelineConfig()
	// bump face-recognition concurrency and disable geo.
	for i := range cfg.Stages {
		switch cfg.Stages[i].Name {
		case StageFaceRecognition:
			n := 3
			cfg.Stages[i].Concurrency = &n
		case StageGeoLookup:
			f := false
			cfg.Stages[i].Enabled = &f
		}
	}
	p := testPipeline(t, nopFuncs(), cfg)

	face := p.stages[StageFaceRecognition]
	if got := face.Queue.GetStatus().MaxConcurrency; got != 3 {
		t.Errorf("face-recognition concurrency = %d, want 3", got)
	}
	if len(face.GatedBy) != 1 || face.GatedBy[0].Name != StageImageThumbnails {
		t.Errorf("face-recognition GatedBy not resolved: %+v", face.GatedBy)
	}
	if p.stages[StageGeoLookup].Enabled {
		t.Errorf("geo-lookup should be disabled")
	}
	if !p.stages[StageBringToCollection].Enabled {
		t.Errorf("bring-to-collection should be enabled")
	}
}
