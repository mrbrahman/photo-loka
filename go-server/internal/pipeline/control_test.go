package pipeline

import (
	"testing"
)

func TestStatus_CoversAllStages(t *testing.T) {
	p, _ := fakePipeline(t, DefaultPipelineConfig())
	st := p.Status()
	for _, name := range allStages {
		if _, ok := st[name]; !ok {
			t.Errorf("Status() missing stage %q", name)
		}
	}
	// Each snapshot has the expected keys.
	snap, _ := st[StageGeoLookup].(map[string]interface{})
	for _, key := range []string{"stage", "pending", "active", "paused", "maxConcurrency", "gatedClosed"} {
		if _, ok := snap[key]; !ok {
			t.Errorf("stage status missing key %q", key)
		}
	}
}

func TestSetStageConcurrency(t *testing.T) {
	p, fakes := fakePipeline(t, DefaultPipelineConfig())

	if ok := p.SetStageConcurrency(StageFaceRecognition, 4); !ok {
		t.Fatal("SetStageConcurrency should succeed for a known stage")
	}
	if got := fakes[StageFaceRecognition].maxConc; got != 4 {
		t.Errorf("face-recognition concurrency = %d, want 4", got)
	}
	if ok := p.SetStageConcurrency("no-such-stage", 2); ok {
		t.Error("SetStageConcurrency should fail for an unknown stage")
	}
}

func TestPauseResumeStage(t *testing.T) {
	p, fakes := fakePipeline(t, DefaultPipelineConfig())

	if ok := p.PauseStage(StageVideoCompression); !ok {
		t.Fatal("PauseStage should succeed for a known stage")
	}
	if !fakes[StageVideoCompression].paused {
		t.Error("video-compression should be paused")
	}
	if ok := p.ResumeStage(StageVideoCompression); !ok {
		t.Fatal("ResumeStage should succeed")
	}
	if fakes[StageVideoCompression].paused {
		t.Error("video-compression should be resumed")
	}

	if p.PauseStage("nope") || p.ResumeStage("nope") {
		t.Error("pause/resume should fail for unknown stage")
	}
}

func TestHasStage(t *testing.T) {
	p, _ := fakePipeline(t, DefaultPipelineConfig())
	if !p.HasStage(StageGeoLookup) {
		t.Error("HasStage should be true for a known stage")
	}
	if p.HasStage("mystery") {
		t.Error("HasStage should be false for an unknown stage")
	}
}
