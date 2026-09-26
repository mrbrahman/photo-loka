package pipeline

import (
	"testing"
)

// fakePipeline builds a pipeline with the given config where every stage uses a
// fakeQueue, and returns the pipeline plus a name->fakeQueue map so tests can
// drive busy/drained state and inspect gate wiring deterministically.
func fakePipeline(t *testing.T, cfg PipelineConfig) (*Pipeline, map[string]*fakeQueue) {
	t.Helper()
	fakes := map[string]*fakeQueue{}
	// The factory is called once per stage, in buildStages creation order. We
	// cannot see the name here, so we capture each fake and match it to its
	// stage afterwards via p.stages.
	var created []*fakeQueue
	qf := func(concurrency int) Queue {
		f := newFakeQueue()
		f.maxConc = concurrency
		created = append(created, f)
		return f
	}
	p := newPipelineWithQueues(nopFuncs(), cfg, qf)
	for name, s := range p.stages {
		fakes[name] = s.Queue.(*fakeQueue)
	}
	return p, fakes
}

// TestWireGates_CanDispatchReflectsUpstreamBusy verifies the orchestrator wired
// face-recognition's gate to image-thumbnails: the installed CanDispatch
// predicate is closed (false) while image-thumbnails reports busy and open
// (true) once it is drained. Fully deterministic -- no real queue, no
// goroutines; the queue's own dispatch behavior is covered by queue_test.go.
func TestWireGates_CanDispatchReflectsUpstreamBusy(t *testing.T) {
	// Disable image-encoding so face-recognition is the clean single-gate case
	// (gated only behind image-thumbnails).
	p, fakes := fakePipeline(t, configWithDisabled(StageImageEncoding))

	thumbs := fakes[StageImageThumbnails]
	face := fakes[StageFaceRecognition]

	// image-thumbnails busy (a task running) => face gate CLOSED.
	thumbs.setBusy(1, 0)
	if face.dispatchAllowed() {
		t.Error("face-recognition should be gated closed while image-thumbnails has a running task")
	}
	// busy via pending only => still closed (gate uses running OR pending).
	thumbs.setBusy(0, 3)
	if face.dispatchAllowed() {
		t.Error("face-recognition should be gated closed while image-thumbnails has pending work")
	}
	// image-thumbnails fully drained => face gate OPEN.
	thumbs.setBusy(0, 0)
	if !face.dispatchAllowed() {
		t.Error("face-recognition should be dispatchable once image-thumbnails is fully drained")
	}
	// The gated stage itself being busy does not close its own gate.
	_ = p
}

// TestWireGates_MultipleUpstreams verifies video-compression (gatedBy
// image-thumbnails, face-recognition, image-encoding in the default config)
// stays closed while ANY listed upstream is busy, and opens only when all are
// drained. This is the non-transitive gate rule: it must name every heavier
// upstream, and it yields to all of them.
func TestWireGates_MultipleUpstreams(t *testing.T) {
	p, fakes := fakePipeline(t, DefaultPipelineConfig())
	_ = p
	compress := fakes[StageVideoCompression]
	thumbs := fakes[StageImageThumbnails]
	face := fakes[StageFaceRecognition]
	encode := fakes[StageImageEncoding]

	// All idle: open.
	if !compress.dispatchAllowed() {
		t.Fatal("video-compression should be open when all upstreams idle")
	}
	// Each upstream, one at a time, closes the gate.
	for _, up := range []*fakeQueue{thumbs, face, encode} {
		up.setBusy(1, 0)
		if compress.dispatchAllowed() {
			t.Error("video-compression should be closed while an upstream is busy")
		}
		up.setBusy(0, 0)
	}
	// All idle again: open.
	if !compress.dispatchAllowed() {
		t.Error("video-compression should reopen once all upstreams drain")
	}
}

// TestWireGates_DrainedKicksDependents verifies the orchestrator wired the
// drained-signal correctly: when image-thumbnails fires its onDrained (its
// busy->drained transition), every stage gated behind it is kicked so it
// re-evaluates its gate. In the default config that is face-recognition,
// image-encoding, and video-compression.
func TestWireGates_DrainedKicksDependents(t *testing.T) {
	_, fakes := fakePipeline(t, DefaultPipelineConfig())

	before := map[string]int{
		StageFaceRecognition:  fakes[StageFaceRecognition].kickCount(),
		StageImageEncoding:    fakes[StageImageEncoding].kickCount(),
		StageVideoCompression: fakes[StageVideoCompression].kickCount(),
	}

	// Simulate image-thumbnails draining.
	fakes[StageImageThumbnails].fireDrained()

	for _, name := range []string{StageFaceRecognition, StageImageEncoding, StageVideoCompression} {
		if got := fakes[name].kickCount(); got != before[name]+1 {
			t.Errorf("%s should have been kicked once on image-thumbnails drain (before=%d after=%d)",
				name, before[name], got)
		}
	}

	// A stage NOT gated behind image-thumbnails (e.g. geo-lookup) is not kicked.
	geoKicks := fakes[StageGeoLookup].kickCount()
	fakes[StageImageThumbnails].fireDrained()
	if fakes[StageGeoLookup].kickCount() != geoKicks {
		t.Error("geo-lookup should not be kicked by image-thumbnails drain (not gated behind it)")
	}
}

// TestWireGates_UngatedHasNoPredicate verifies stages with no gatedBy get no
// CanDispatch predicate installed (they are never gated closed).
func TestWireGates_UngatedHasNoPredicate(t *testing.T) {
	_, fakes := fakePipeline(t, DefaultPipelineConfig())
	for _, name := range []string{StageBringToCollection, StageGeoLookup, StageVideoThumbnail, StageImageThumbnails} {
		if fakes[name].canDispatch != nil {
			t.Errorf("%s is ungated and should have no CanDispatch predicate", name)
		}
	}
}
