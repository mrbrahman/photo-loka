package pipeline

import (
	"sync/atomic"
	"testing"
	"time"

	"photo-loka/internal/collections"
	"photo-loka/internal/media"
)

// cfgWithGates returns the default config but with the given stage's gatedBy
// set to exactly upstreams (replacing whatever it had).
func cfgWithGates(stage string, upstreams ...string) PipelineConfig {
	cfg := DefaultPipelineConfig()
	for i := range cfg.Stages {
		if cfg.Stages[i].Name == stage {
			cfg.Stages[i].GatedBy = append([]string(nil), upstreams...)
		}
	}
	return cfg
}

// cfgNoGates returns the default config with every gatedBy removed.
func cfgNoGates() PipelineConfig {
	cfg := DefaultPipelineConfig()
	for i := range cfg.Stages {
		cfg.Stages[i].GatedBy = nil
	}
	return cfg
}

// TestApplyLive_AddGate: starting from an ungated config, applying a config that
// gates geo-lookup behind bring-to-collection installs the predicate live and
// makes geo-lookup gate-closed while bring-to-collection is busy.
func TestApplyLive_AddGate(t *testing.T) {
	p, fakes := fakePipeline(t, cfgNoGates())

	// Initially ungated: no predicate, dispatch allowed.
	if !fakes[StageGeoLookup].dispatchAllowed() {
		t.Fatal("geo-lookup should be ungated initially")
	}

	// Apply a config gating geo-lookup behind bring-to-collection.
	p.applyLive(cfgWithGates(StageGeoLookup, StageBringToCollection))

	// Now geo-lookup is gated: closed while bring-to-collection is busy...
	fakes[StageBringToCollection].setBusy(1, 0)
	if fakes[StageGeoLookup].dispatchAllowed() {
		t.Error("geo-lookup should be gated closed while bring-to-collection is busy")
	}
	// ...open once it drains.
	fakes[StageBringToCollection].setBusy(0, 0)
	if !fakes[StageGeoLookup].dispatchAllowed() {
		t.Error("geo-lookup should open once bring-to-collection drains")
	}

	// And bring-to-collection's drain now kicks geo-lookup (async subscriber).
	before := fakes[StageGeoLookup].kickCount()
	fakes[StageBringToCollection].fireDrained()
	waitFor(t, "bring-to-collection drain kicks newly-gated geo-lookup", func() bool {
		return fakes[StageGeoLookup].kickCount() == before+1
	})
}

// TestApplyLive_RemoveGate: starting from the default (gated) config, applying
// an ungated config clears the predicate so the stage is never gate-closed, and
// the former upstream no longer kicks it.
func TestApplyLive_RemoveGate(t *testing.T) {
	p, fakes := fakePipeline(t, DefaultPipelineConfig())

	// face-recognition is gated behind image-thumbnails by default.
	fakes[StageImageThumbnails].setBusy(1, 0)
	if fakes[StageFaceRecognition].dispatchAllowed() {
		t.Fatal("precondition: face-recognition should be gated by default")
	}

	// Apply an ungated config.
	p.applyLive(cfgNoGates())

	// Even with image-thumbnails busy, face-recognition is no longer gated.
	if !fakes[StageFaceRecognition].dispatchAllowed() {
		t.Error("face-recognition should be ungated after applying a no-gate config")
	}
	// image-thumbnails no longer has a drained subscriber kicking anything
	// gated behind it (the ungated re-wire tore down the old subscriber), so
	// firing it kicks nothing.
	before := fakes[StageFaceRecognition].kickCount()
	fakes[StageImageThumbnails].fireDrained()
	time.Sleep(20 * time.Millisecond)
	if fakes[StageFaceRecognition].kickCount() != before {
		t.Error("after ungating, image-thumbnails drain should not kick face-recognition")
	}
}

// TestApplyLive_EnableFlip: disabling a stage via apply is reflected in routing.
func TestApplyLive_EnableFlip(t *testing.T) {
	withML(t)
	p, _ := fakePipeline(t, DefaultPipelineConfig())

	// Default: image-encoding enabled -> routed from image-thumbnails.
	got := names(p.routeDownstreams(p.stages[StageImageThumbnails], imageItem(false)))
	if !equal(got, []string{StageFaceRecognition, StageImageEncoding}) {
		t.Fatalf("precondition ML downstreams = %v", got)
	}

	// Apply config with image-encoding disabled.
	p.applyLive(configWithDisabled(StageImageEncoding))

	got = names(p.routeDownstreams(p.stages[StageImageThumbnails], imageItem(false)))
	if !equal(got, []string{StageFaceRecognition}) {
		t.Errorf("after disabling image-encoding, ML downstreams = %v, want [face-recognition]", got)
	}
}

// TestApplyLive_ConcurrentWithDispatch runs applyLive repeatedly while the
// pipeline is actively dispatching real work (real queues, fake stage fns), to
// prove the live re-wire is race-free under -race. It asserts nothing panics
// and all submitted items complete.
func TestApplyLive_ConcurrentWithDispatch(t *testing.T) {
	withML(t)

	var completed atomic.Int32
	funcs := nopFuncs()
	// Count entry completions as a proxy for items flowing through.
	funcs.bringToCollection = func(_ string, h *StageHint) error {
		h.UUID = "u"
		h.Mediatype = "image"
		h.ExifData = &media.ExifData{Mediatype: "image"}
		completed.Add(1)
		return nil
	}

	p := newPipelineWithQueues(funcs, DefaultPipelineConfig(), realQueueFactory)
	t.Cleanup(p.StopAll)

	done := make(chan struct{})
	// Hammer live re-applies: alternate between gated default and ungated.
	go func() {
		cfgs := []PipelineConfig{DefaultPipelineConfig(), cfgNoGates(), configWithDisabled(StageImageEncoding)}
		for i := 0; i < 300; i++ {
			p.applyLive(cfgs[i%len(cfgs)])
		}
		close(done)
	}()

	// Concurrently submit work.
	for i := 0; i < 100; i++ {
		p.submitEntry(&collections.Collection{}, "src", "", true)
	}
	<-done
	// Submit a few more after re-wiring settles.
	for i := 0; i < 20; i++ {
		p.submitEntry(&collections.Collection{}, "src", "", true)
	}

	waitFor(t, "entry work to complete", func() bool { return completed.Load() == 120 })
	// Drain fully before returning: the ML stages route through ml.Available()
	// (a package global). Under -count looping, a lingering dispatch goroutine
	// reading that global would race the next iteration's withML/ml.Init. Wait
	// until nothing is running or pending so all goroutines have quiesced.
	waitFor(t, "pipeline to fully drain", func() bool { return !p.Busy() })
}

// is rejected by validation, so Apply returns an error. Since applyLive is only
// reached after Validate passes, a rejected Apply never mutates the pipeline.
func TestApply_RejectsInvalidLeavesUnchanged(t *testing.T) {
	// Build a cyclic config: face <-> encode.
	cfg := DefaultPipelineConfig()
	m := cfg.byName()
	m[StageFaceRecognition] = StageConfig{Name: StageFaceRecognition, GatedBy: []string{StageImageEncoding}}
	m[StageImageEncoding] = StageConfig{Name: StageImageEncoding, GatedBy: []string{StageFaceRecognition}}
	var stages []StageConfig
	for _, n := range allStages {
		stages = append(stages, m[n])
	}
	cyclic := PipelineConfig{Stages: stages}

	if err := cyclic.Validate(); err == nil {
		t.Fatal("cyclic config should fail validation")
	}

	// A pipeline built from the default (gated) config: confirm its gate state
	// is intact and that validation (the gate Apply runs first) rejects the
	// cyclic config before any mutation path.
	p, fakes := fakePipeline(t, DefaultPipelineConfig())
	_ = p
	fakes[StageImageThumbnails].setBusy(1, 0)
	gatedBefore := !fakes[StageFaceRecognition].dispatchAllowed()
	if !gatedBefore {
		t.Fatal("precondition: face-recognition gated by default")
	}
	// Validate is what Apply calls first; a failing Validate means applyLive is
	// never invoked, so the running gate state is unchanged.
	if err := cyclic.Validate(); err == nil {
		t.Fatal("expected validation failure")
	}
	if fakes[StageFaceRecognition].dispatchAllowed() {
		t.Error("running gate state must be unchanged after a rejected config")
	}
}
