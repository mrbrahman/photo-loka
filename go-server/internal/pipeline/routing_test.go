package pipeline

import (
	"sort"
	"sync"
	"testing"
	"time"

	"photo-loka/internal/collections"
	"photo-loka/internal/config"
	"photo-loka/internal/media"
	"photo-loka/internal/ml"
)

// nopFuncs returns a stageFuncs where every stage is a no-op success. Tests
// override individual fields as needed.
func nopFuncs() stageFuncs {
	nop := func(string, *StageHint) error { return nil }
	return stageFuncs{
		bringToCollection: nop,
		geoLookup:         nop,
		videoThumbnail:    nop,
		imageThumbnails:   nop,
		faceRecognition:   nop,
		imageEncoding:     nop,
		videoCompression:  nop,
	}
}

// testPipeline builds a pipeline with the given funcs and config. No indexing
// hooks are wired, so no DB is touched; the pipeline creates its own stage
// queues.
func testPipeline(t *testing.T, funcs stageFuncs, cfg PipelineConfig) *Pipeline {
	t.Helper()
	p := newPipeline(funcs, cfg)
	t.Cleanup(p.StopAll)
	return p
}

func names(stages []*Stage) []string {
	out := make([]string, len(stages))
	for i, s := range stages {
		out[i] = s.Name
	}
	sort.Strings(out)
	return out
}

func ptrF(v float64) *float64 { return &v }
func ptrI(v int) *int         { return &v }

func imageItem(gps bool) *PipelineItem {
	ex := &media.ExifData{Mediatype: "image"}
	if gps {
		ex.GPSLat = ptrF(1)
		ex.GPSLng = ptrF(2)
	}
	return &PipelineItem{Mediatype: "image", ExifData: ex}
}

func videoItem(gps, compress bool) *PipelineItem {
	ex := &media.ExifData{Mediatype: "video"}
	if gps {
		ex.GPSLat = ptrF(1)
		ex.GPSLng = ptrF(2)
	}
	col := &collections.Collection{}
	if compress {
		col.CompressVideos = ptrI(1)
	}
	return &PipelineItem{Mediatype: "video", ExifData: ex, Collection: col}
}

// withML makes ml.Available() report true for the test (the ML stages route
// only when the ML client is wired), restoring prior state on cleanup. Stage
// enablement itself now comes from the pipeline config, not a runtime toggle.
func withML(t *testing.T) {
	t.Helper()
	prevStartup := config.Startup
	if config.Startup == nil {
		config.Startup = &config.StartupConfig{MLServiceURL: "http://localhost:8000"}
	}
	ml.Init() // constructs an HTTP client only (no network); makes ml.Available() true
	t.Cleanup(func() { config.Startup = prevStartup })
}

// --- Layer 2: routing decisions ---

// ungatedConfig returns the default config with all gatedBy edges removed, so
// flow tests exercise routing/forwarding deterministically without gate timing
// (gating is covered separately by the queue-level tests).
func ungatedConfig() PipelineConfig {
	cfg := DefaultPipelineConfig()
	for i := range cfg.Stages {
		cfg.Stages[i].GatedBy = nil
	}
	return cfg
}

// configWithDisabled returns the default config with the named stages disabled.
func configWithDisabled(disabled ...string) PipelineConfig {
	off := make(map[string]bool)
	for _, n := range disabled {
		off[n] = true
	}
	cfg := DefaultPipelineConfig()
	for i := range cfg.Stages {
		if off[cfg.Stages[i].Name] {
			f := false
			cfg.Stages[i].Enabled = &f
		}
	}
	return cfg
}

func TestRouteDownstreams_BringToCollection(t *testing.T) {
	withML(t)
	p := testPipeline(t, nopFuncs(), DefaultPipelineConfig())
	entry := p.stages[StageBringToCollection]

	cases := []struct {
		name string
		item *PipelineItem
		want []string
	}{
		{"image+gps", imageItem(true), []string{StageImageThumbnails, StageGeoLookup}},
		{"image,no-gps", imageItem(false), []string{StageImageThumbnails}},
		{"video+gps+compress", videoItem(true, true), []string{StageVideoThumbnail, StageGeoLookup, StageVideoCompression}},
		{"video,no-gps,compress", videoItem(false, true), []string{StageVideoThumbnail, StageVideoCompression}},
		{"video+gps,no-compress", videoItem(true, false), []string{StageVideoThumbnail, StageGeoLookup}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := names(p.routeDownstreams(entry, c.item))
			want := append([]string(nil), c.want...)
			sort.Strings(want)
			if !equal(got, want) {
				t.Errorf("routeDownstreams = %v, want %v", got, want)
			}
		})
	}
}

func TestRouteDownstreams_DisabledOptionalStagesSkipped(t *testing.T) {
	// Disable geo-lookup and video-compression: an image with GPS routes only to
	// thumbnails; a video with compression routes only to video-thumbnail.
	p := testPipeline(t, nopFuncs(), configWithDisabled(StageGeoLookup, StageVideoCompression))
	entry := p.stages[StageBringToCollection]

	if got := names(p.routeDownstreams(entry, imageItem(true))); !equal(got, []string{StageImageThumbnails}) {
		t.Errorf("image+gps with geo disabled = %v, want [generate-image-thumbnails]", got)
	}
	got := names(p.routeDownstreams(entry, videoItem(true, true)))
	want := []string{StageVideoThumbnail}
	sort.Strings(want)
	// geo also disabled, so only the video-thumbnail branch remains.
	if !equal(got, want) {
		t.Errorf("video with geo+compression disabled = %v, want %v", got, want)
	}
}

func TestRouteDownstreams_VideoThumbnailAlwaysFeedsImageThumbnails(t *testing.T) {
	p := testPipeline(t, nopFuncs(), DefaultPipelineConfig())
	vt := p.stages[StageVideoThumbnail]
	got := names(p.routeDownstreams(vt, videoItem(false, false)))
	want := []string{StageImageThumbnails}
	if !equal(got, want) {
		t.Errorf("video-thumbnail downstreams = %v, want %v", got, want)
	}
}

func TestRouteDownstreams_ImageThumbnailsMLStages(t *testing.T) {
	// ML must be available for the ML stages to route at all (ml.Available()).
	// Enablement beyond that comes from the pipeline config.
	withML(t)
	it := func(p *Pipeline) []string {
		return names(p.routeDownstreams(p.stages[StageImageThumbnails], imageItem(false)))
	}

	// Default config: both ML stages (image-encoding is now enabled by default).
	p2 := testPipeline(t, nopFuncs(), DefaultPipelineConfig())
	if got := it(p2); !equal(got, []string{StageFaceRecognition, StageImageEncoding}) {
		t.Errorf("ML downstreams (default) = %v, want [face-recognition image-encoding]", got)
	}

	// image-encoding disabled: only face-recognition.
	p3 := testPipeline(t, nopFuncs(), configWithDisabled(StageImageEncoding))
	if got := it(p3); !equal(got, []string{StageFaceRecognition}) {
		t.Errorf("ML downstreams (encoding off) = %v, want [face-recognition]", got)
	}

	// Both ML stages disabled: none.
	p4 := testPipeline(t, nopFuncs(), configWithDisabled(StageFaceRecognition, StageImageEncoding))
	if got := it(p4); len(got) != 0 {
		t.Errorf("ML downstreams (both off) = %v, want none", got)
	}
}

// --- Layer 3: orchestrated flow with fake stage funcs ---

// recorder captures which stages ran and in what order, and lets a fake stage
// write outputs into the hint to verify propagation.
type recorder struct {
	mu    sync.Mutex
	order []string
}

func (r *recorder) mark(name string) {
	r.mu.Lock()
	r.order = append(r.order, name)
	r.mu.Unlock()
}

func (r *recorder) ran(name string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, n := range r.order {
		if n == name {
			return true
		}
	}
	return false
}

func (r *recorder) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.order)
}

func waitFor(t *testing.T, msg string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timeout waiting for: %s", msg)
}

// TestFlow_ImageItem: an image with GPS flows entry -> geo + thumbnails ->
// face-recognition, and the MLBuf set by thumbnails reaches face-recognition.
func TestFlow_ImageItem(t *testing.T) {
	withML(t)

	rec := &recorder{}
	funcs := nopFuncs()

	// Entry produces uuid + image mediatype + GPS exif (so geo runs).
	funcs.bringToCollection = func(_ string, h *StageHint) error {
		rec.mark(StageBringToCollection)
		h.UUID = "u1"
		h.Mediatype = "image"
		h.FinalFile = "/x/a.jpg"
		h.ExifData = &media.ExifData{Mediatype: "image", GPSLat: ptrF(1), GPSLng: ptrF(2)}
		return nil
	}
	funcs.geoLookup = func(uuid string, _ *StageHint) error {
		if uuid != "u1" {
			t.Errorf("geo got uuid %q, want u1", uuid)
		}
		rec.mark(StageGeoLookup)
		return nil
	}
	funcs.imageThumbnails = func(uuid string, h *StageHint) error {
		if uuid != "u1" {
			t.Errorf("thumbnails got uuid %q, want u1", uuid)
		}
		rec.mark(StageImageThumbnails)
		h.MLBuf = &media.MLBuffer{Scale: 2.0} // output handed downstream
		return nil
	}
	funcs.faceRecognition = func(uuid string, h *StageHint) error {
		rec.mark(StageFaceRecognition)
		if h.MLBuf == nil || h.MLBuf.Scale != 2.0 {
			t.Errorf("face-recognition did not receive MLBuf from thumbnails: %+v", h.MLBuf)
		}
		return nil
	}
	// These must NOT run for an image item.
	funcs.videoThumbnail = func(string, *StageHint) error { rec.mark(StageVideoThumbnail); return nil }
	funcs.videoCompression = func(string, *StageHint) error { rec.mark(StageVideoCompression); return nil }

	p := testPipeline(t, funcs, ungatedConfig())
	p.submitEntry(&collections.Collection{}, "/src/a.jpg", "", true)

	waitFor(t, "flow to reach face-recognition", func() bool { return rec.ran(StageFaceRecognition) })
	// Let any erroneous extra stages surface.
	time.Sleep(20 * time.Millisecond)

	for _, want := range []string{StageBringToCollection, StageGeoLookup, StageImageThumbnails, StageFaceRecognition} {
		if !rec.ran(want) {
			t.Errorf("expected stage %q to run", want)
		}
	}
	for _, notWant := range []string{StageVideoThumbnail, StageVideoCompression} {
		if rec.ran(notWant) {
			t.Errorf("stage %q ran for an image item", notWant)
		}
	}
}

// TestFlow_VideoItem: a video with compression flows entry -> video-thumbnail +
// video-compression, and video-thumbnail feeds image-thumbnails.
func TestFlow_VideoItem(t *testing.T) {
	rec := &recorder{}
	funcs := nopFuncs()
	funcs.bringToCollection = func(_ string, h *StageHint) error {
		rec.mark(StageBringToCollection)
		h.UUID = "v1"
		h.Mediatype = "video"
		h.FinalFile = "/x/a.mp4"
		h.ExifData = &media.ExifData{Mediatype: "video"} // no GPS -> no geo
		return nil
	}
	funcs.videoThumbnail = func(_ string, _ *StageHint) error { rec.mark(StageVideoThumbnail); return nil }
	funcs.videoCompression = func(_ string, _ *StageHint) error { rec.mark(StageVideoCompression); return nil }
	funcs.imageThumbnails = func(_ string, _ *StageHint) error { rec.mark(StageImageThumbnails); return nil }
	funcs.geoLookup = func(_ string, _ *StageHint) error { rec.mark(StageGeoLookup); return nil }

	col := &collections.Collection{CompressVideos: ptrI(1)}
	p := testPipeline(t, funcs, ungatedConfig())
	p.submitEntry(col, "/src/a.mp4", "", true)

	// image-thumbnails is downstream of video-thumbnail; wait for it.
	waitFor(t, "flow to reach image-thumbnails", func() bool { return rec.ran(StageImageThumbnails) })
	time.Sleep(20 * time.Millisecond)

	for _, want := range []string{StageBringToCollection, StageVideoThumbnail, StageVideoCompression, StageImageThumbnails} {
		if !rec.ran(want) {
			t.Errorf("expected stage %q to run", want)
		}
	}
	if rec.ran(StageGeoLookup) {
		t.Errorf("geo-lookup ran for a video with no GPS")
	}
}

// TestFlow_EntryError_NoDownstream: if the entry stage fails, nothing downstream
// runs (the task returns an error before forwarding).
func TestFlow_EntryError_NoDownstream(t *testing.T) {
	rec := &recorder{}
	funcs := nopFuncs()
	funcs.bringToCollection = func(_ string, _ *StageHint) error {
		rec.mark(StageBringToCollection)
		return errBoom
	}
	funcs.imageThumbnails = func(_ string, _ *StageHint) error { rec.mark(StageImageThumbnails); return nil }

	p := testPipeline(t, funcs, ungatedConfig())
	p.submitEntry(&collections.Collection{}, "/src/a.jpg", "", true)

	waitFor(t, "entry to run", func() bool { return rec.ran(StageBringToCollection) })
	time.Sleep(20 * time.Millisecond)
	if rec.count() != 1 {
		t.Fatalf("downstream ran despite entry error; order=%v", rec.order)
	}
}

var errBoom = &boomError{}

type boomError struct{}

func (*boomError) Error() string { return "boom" }

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
