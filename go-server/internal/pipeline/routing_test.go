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
		geoCache:          nop,
		geoAddr:           nop,
		geoCity:           nop,
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

func names(stages []*node) []string {
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
		{"image+gps", imageItem(true), []string{StageImageThumbnails, StageGeoCache}},
		{"image,no-gps", imageItem(false), []string{StageImageThumbnails}},
		{"video+gps+compress", videoItem(true, true), []string{StageVideoThumbnail, StageGeoCache, StageVideoCompression}},
		{"video,no-gps,compress", videoItem(false, true), []string{StageVideoThumbnail, StageVideoCompression}},
		{"video+gps,no-compress", videoItem(true, false), []string{StageVideoThumbnail, StageGeoCache}},
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
	p := testPipeline(t, nopFuncs(), configWithDisabled(StageGeoCache, StageVideoCompression))
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

// TestRouteDownstreams_GeoChain verifies the geo chain routes on stage output
// (like the media-type branch): geo-cache -> geo-lookup-addr only when the
// local phase reported a US cache miss (GeoNeedsAPI), and geo-lookup-addr ->
// geo-lookup-city only when the address lookup reported an empty placename
// (GeoNeedsCity). Terminal otherwise.
func TestRouteDownstreams_GeoChain(t *testing.T) {
	p := testPipeline(t, nopFuncs(), DefaultPipelineConfig())
	cache := p.stages[StageGeoCache]
	addr := p.stages[StageGeoAddr]

	// geo-cache: no API needed (resolved locally) -> terminal.
	if got := names(p.routeDownstreams(cache, &PipelineItem{})); len(got) != 0 {
		t.Errorf("geo-cache with GeoNeedsAPI=false should be terminal, got %v", got)
	}
	// geo-cache: US cache miss -> geo-lookup-addr.
	if got := names(p.routeDownstreams(cache, &PipelineItem{GeoNeedsAPI: true})); !equal(got, []string{StageGeoAddr}) {
		t.Errorf("geo-cache with GeoNeedsAPI=true = %v, want [geo-lookup-addr]", got)
	}

	// geo-lookup-addr: no city needed -> terminal.
	if got := names(p.routeDownstreams(addr, &PipelineItem{})); len(got) != 0 {
		t.Errorf("geo-lookup-addr with GeoNeedsCity=false should be terminal, got %v", got)
	}
	// geo-lookup-addr: empty placename -> geo-lookup-city.
	if got := names(p.routeDownstreams(addr, &PipelineItem{GeoNeedsCity: true})); !equal(got, []string{StageGeoCity}) {
		t.Errorf("geo-lookup-addr with GeoNeedsCity=true = %v, want [geo-lookup-city]", got)
	}

	// geo-lookup-city is terminal regardless.
	if got := names(p.routeDownstreams(p.stages[StageGeoCity], &PipelineItem{GeoNeedsCity: true})); len(got) != 0 {
		t.Errorf("geo-lookup-city should be terminal, got %v", got)
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
	funcs.geoCache = func(uuid string, _ *StageHint) error {
		if uuid != "u1" {
			t.Errorf("geo got uuid %q, want u1", uuid)
		}
		rec.mark(StageGeoCache)
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

	for _, want := range []string{StageBringToCollection, StageGeoCache, StageImageThumbnails, StageFaceRecognition} {
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
	funcs.geoCache = func(_ string, _ *StageHint) error { rec.mark(StageGeoCache); return nil }

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
	if rec.ran(StageGeoCache) {
		t.Errorf("geo-lookup ran for a video with no GPS")
	}
}

// TestFlow_GeoChain_CarriesParsedAddress drives the full geo chain with real
// queues and asserts the parsed address set by geo-lookup-addr reaches
// geo-lookup-city. This guards the hint handoff: geo-lookup-addr writes
// GeoParsedAddr on the hint, the pipeline absorbs it onto the item and forwards
// a clone, and that clone's hint must carry GeoParsedAddr into the city stage.
// (Regression: hint() previously dropped the geo signal fields, so the city
// stage failed with "requires a parsed address".)
func TestFlow_GeoChain_CarriesParsedAddress(t *testing.T) {
	rec := &recorder{}
	funcs := nopFuncs()
	funcs.bringToCollection = func(_ string, h *StageHint) error {
		rec.mark(StageBringToCollection)
		h.UUID = "g1"
		h.Mediatype = "image"
		h.ExifData = &media.ExifData{Mediatype: "image", GPSLat: ptrF(40), GPSLng: ptrF(-74)}
		return nil
	}
	funcs.geoCache = func(_ string, h *StageHint) error {
		rec.mark(StageGeoCache)
		h.GeoNeedsAPI = true // simulate a US cache miss -> route to addr
		h.GeoLat, h.GeoLng = 40, -74
		return nil
	}
	funcs.geoAddr = func(_ string, h *StageHint) error {
		rec.mark(StageGeoAddr)
		h.GeoNeedsCity = true // simulate empty placename -> route to city
		h.GeoParsedAddr = `{"postalcode":"10001","countryCode":"US"}`
		return nil
	}
	var mu sync.Mutex
	var gotAddr string
	funcs.geoCity = func(_ string, h *StageHint) error {
		mu.Lock()
		gotAddr = h.GeoParsedAddr
		mu.Unlock()
		rec.mark(StageGeoCity)
		return nil
	}

	p := testPipeline(t, funcs, ungatedConfig())
	p.submitEntry(&collections.Collection{}, "/src/a.jpg", "", true)

	waitFor(t, "flow to reach geo-lookup-city", func() bool { return rec.ran(StageGeoCity) })
	for _, want := range []string{StageGeoCache, StageGeoAddr, StageGeoCity} {
		if !rec.ran(want) {
			t.Errorf("expected geo stage %q to run", want)
		}
	}
	mu.Lock()
	got := gotAddr
	mu.Unlock()
	if got != `{"postalcode":"10001","countryCode":"US"}` {
		t.Errorf("geo-lookup-city received parsed address %q, want the one set by geo-lookup-addr", got)
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
