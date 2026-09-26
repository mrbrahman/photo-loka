// Package pipeline is the indexing orchestrator. It wires the fixed media data
// flow (bring-to-collection -> thumbnails -> ML, plus geo and video branches)
// as a set of Stage instances, each backed by its own queue.Queue. Data flow
// (Downstreams) is hardcoded here; resource gating (GatedBy) is layered on in a
// later phase from config. See docs/pipeline-dag-design.md.
package pipeline

import (
	"log/slog"

	"photo-loka/internal/collections"
	"photo-loka/internal/database"
	"photo-loka/internal/geo"
	"photo-loka/internal/indexing"
	"photo-loka/internal/queue"
)

// Stage name constants (also the config keys in a later phase).
const (
	StageBringToCollection = "bring-to-collection"
	StageGeoLookup         = "geo-lookup"
	StageVideoThumbnail    = "generate-video-thumbnail"
	StageImageThumbnails   = "generate-image-thumbnails"
	StageFaceRecognition   = "face-recognition"
	StageImageEncoding     = "image-encoding"
	StageVideoCompression  = "video-compression"
)

// Pipeline is the process-wide orchestrator singleton. It owns the stage graph
// and provides Submit (entry) plus standalone per-stage enqueue.
type Pipeline struct {
	stages map[string]*Stage
	entry  *Stage
}

// P is the package-level pipeline singleton, built by Init.
var P *Pipeline

func plLogger() *slog.Logger { return slog.Default().With("component", "pipeline") }

// Init loads the pipeline config from runtime_config (falling back to the
// built-in default), builds the stage graph, wires gates, and injects the
// indexing/geo hooks. Requires geo.Init/ml.Init and config.LoadRuntimeConfig to
// have run. Called once at startup.
func Init() *Pipeline {
	cfg := loadConfig()
	p := newPipeline(realStageFuncs(), cfg)

	// Inject indexing package hooks (function-var indirection avoids an import
	// cycle: pipeline imports indexing, not vice versa).
	indexing.SubmitEntry = p.submitEntry
	indexing.SubmitRefresh = p.submitRefresh
	indexing.PipelineStatus = p.legacyStatus
	indexing.PipelinePause = p.PauseAll
	indexing.PipelineResume = p.ResumeAll
	indexing.PipelineErrors = p.aggregateErrors
	indexing.PipelineSetConcurrency = p.setEntryConcurrency
	indexing.PipelineBusy = p.Busy

	// Wire geo's reverse-geo-encoding endpoints to the geo-lookup stage using
	// the generic per-stage mechanism (EnqueueStage/StageStatus). Same pattern
	// the future per-stage API will use for every stage.
	geo.EnqueueLookup = func(uuid string) {
		_ = p.EnqueueStage(StageGeoLookup, uuid, nil, queue.Normal)
	}
	geo.LookupStatus = func() map[string]interface{} {
		return p.StageStatus(StageGeoLookup)
	}

	P = p
	return p
}

// loadConfig reads and validates the pipeline config from the runtime_config
// 'pipelineConfig' row. On any problem (missing row, parse/validate error) it
// logs and falls back to the built-in default so the server still starts.
func loadConfig() PipelineConfig {
	var raw string
	err := database.DB.QueryRow(
		"SELECT value FROM runtime_config WHERE key = 'pipelineConfig'",
	).Scan(&raw)
	if err != nil {
		plLogger().Warn("no pipelineConfig row; using default pipeline config", "error", err)
		return DefaultPipelineConfig()
	}
	cfg, err := ParsePipelineConfig(raw)
	if err != nil {
		plLogger().Error("invalid pipelineConfig; using default", "error", err)
		return DefaultPipelineConfig()
	}
	return cfg
}

// stageFuncs is the set of stage work functions, one per stage. Introduced as a
// seam: production uses realStageFuncs(); tests inject fakes to exercise the
// orchestrated forwarding and gate behavior without external dependencies
// (DB, libvips, ffmpeg, ML service).
type stageFuncs struct {
	bringToCollection StageFn
	geoLookup         StageFn
	videoThumbnail    StageFn
	imageThumbnails   StageFn
	faceRecognition   StageFn
	imageEncoding     StageFn
	videoCompression  StageFn
}

// realStageFuncs returns the production stage work functions.
func realStageFuncs() stageFuncs {
	return stageFuncs{
		bringToCollection: stageBringToCollection,
		geoLookup:         stageGeoLookup,
		videoThumbnail:    stageVideoThumbnail,
		imageThumbnails:   stageImageThumbnails,
		faceRecognition:   stageFaceRecognition,
		imageEncoding:     stageImageEncoding,
		videoCompression:  stageVideoCompression,
	}
}

// queueFactory creates a Queue for a stage at the given concurrency. Production
// uses realQueueFactory (a *queue.Queue); tests inject fakes.
type queueFactory func(concurrency int) Queue

// realQueueFactory builds a real work queue.
func realQueueFactory(concurrency int) Queue { return queue.New(concurrency) }

// newPipeline builds the stage graph from the given config with real queues and
// wires gates. It does NOT inject the indexing/geo hooks (those need a real DB);
// Init does that for production. Tests call newPipeline for real-queue behavior
// or newPipelineWithQueues to inject fake queues.
func newPipeline(funcs stageFuncs, cfg PipelineConfig) *Pipeline {
	return newPipelineWithQueues(funcs, cfg, realQueueFactory)
}

// newPipelineWithQueues is newPipeline with an injectable queue factory, for
// tests that drive gating deterministically via a fake Queue.
func newPipelineWithQueues(funcs stageFuncs, cfg PipelineConfig, qf queueFactory) *Pipeline {
	p := &Pipeline{stages: make(map[string]*Stage)}
	p.buildStages(funcs, cfg, qf)
	p.wireGates()
	return p
}

// buildStages constructs the fixed data-flow graph and applies the tunable
// config (per-stage concurrency, enable flag, and gatedBy edges). Downstreams
// (data flow) are hardcoded; GatedBy (scheduling) comes from config. Queues are
// created via qf.
func (p *Pipeline) buildStages(funcs stageFuncs, cfg PipelineConfig, qf queueFactory) {
	byName := cfg.byName()
	newStage := func(name string, fn StageFn) *Stage {
		sc := byName[name]
		s := &Stage{
			Name:    name,
			Fn:      fn,
			Queue:   qf(sc.concurrency()),
			Enabled: sc.enabled(),
		}
		p.stages[name] = s
		return s
	}

	// Create all stages first (concurrency + enable applied from config).
	geoLookup := newStage(StageGeoLookup, funcs.geoLookup)
	faceRecognition := newStage(StageFaceRecognition, funcs.faceRecognition)
	imageEncoding := newStage(StageImageEncoding, funcs.imageEncoding)
	videoCompression := newStage(StageVideoCompression, funcs.videoCompression)
	imageThumbs := newStage(StageImageThumbnails, funcs.imageThumbnails)
	videoThumb := newStage(StageVideoThumbnail, funcs.videoThumbnail)
	entry := newStage(StageBringToCollection, funcs.bringToCollection)

	// Data flow (hardcoded): generate-image-thumbnails feeds both ML stages;
	// generate-video-thumbnail feeds generate-image-thumbnails; the entry fans
	// out to geo-lookup and the media-type branch (routeDownstreams filters by
	// media type at enqueue time).
	imageThumbs.Downstreams = []*Stage{faceRecognition, imageEncoding}
	videoThumb.Downstreams = []*Stage{imageThumbs}
	entry.Downstreams = []*Stage{geoLookup, videoThumb, imageThumbs, videoCompression}
	p.entry = entry

	// Resource gating (from config): resolve each stage's gatedBy names to
	// *Stage. Names are validated before this point.
	for _, sc := range cfg.Stages {
		if len(sc.GatedBy) == 0 {
			continue
		}
		s := p.stages[sc.Name]
		for _, up := range sc.GatedBy {
			if u, ok := p.stages[up]; ok {
				s.GatedBy = append(s.GatedBy, u)
			}
		}
	}
}

// wireGates installs each stage's CanDispatch predicate and each upstream's
// onDrained kick. Safe to call once at startup.
func (p *Pipeline) wireGates() {
	// Build reverse index: upstream -> stages gated behind it, so an upstream's
	// drained signal knows whom to kick.
	dependents := make(map[*Stage][]*Stage)
	for _, s := range p.stages {
		stage := s
		if len(stage.GatedBy) > 0 {
			stage.Queue.SetCanDispatch(func() bool { return !stage.upstreamBusy() })
			for _, up := range stage.GatedBy {
				dependents[up] = append(dependents[up], stage)
			}
		}
	}
	for up, gated := range dependents {
		kickees := gated
		up.Queue.SetOnDrained(func() {
			for _, g := range kickees {
				g.Queue.Kick()
			}
		})
	}
}

// Busy reports whether any stage has running or pending work.
func (p *Pipeline) Busy() bool {
	for _, s := range p.stages {
		st := s.Queue.GetStatus()
		if st.Active > 0 || st.Pending > 0 {
			return true
		}
	}
	return false
}

// PauseAll pauses every stage queue (admin control).
func (p *Pipeline) PauseAll() {
	for _, s := range p.stages {
		s.Queue.Pause()
	}
}

// ResumeAll resumes every stage queue (admin control).
func (p *Pipeline) ResumeAll() {
	for _, s := range p.stages {
		s.Queue.Resume()
	}
}

// StopAll stops every stage's dispatch goroutine (shutdown).
func (p *Pipeline) StopAll() {
	for _, s := range p.stages {
		s.Queue.Stop()
	}
}

// setEntryConcurrency adjusts the entry (bring-to-collection) and thumbnail
// stages' concurrency, backing the legacy "indexer concurrency" knob.
func (p *Pipeline) setEntryConcurrency(n int) {
	for _, name := range []string{StageBringToCollection, StageImageThumbnails, StageVideoThumbnail} {
		if s, ok := p.stages[name]; ok {
			s.Queue.SetConcurrency(n)
		}
	}
}

// StageStatus returns a status snapshot for one stage, or nil if the name is
// unknown. This is the per-stage building block the eventual per-stage API and
// the geo endpoints consume; legacyStatus aggregates over it.
func (p *Pipeline) StageStatus(name string) map[string]interface{} {
	s, ok := p.stages[name]
	if !ok {
		return nil
	}
	st := s.Queue.GetStatus()
	high, normal, low := s.Queue.QueueSizes()
	return map[string]interface{}{
		"stage":          name,
		"pending":        st.Pending,
		"active":         st.Active,
		"completed":      st.Completed,
		"failed":         st.Failed,
		"paused":         st.IsPaused,
		"maxConcurrency": st.MaxConcurrency,
		"gatedClosed":    s.upstreamBusy(),
		"queueSizes":     map[string]int{"high": high, "normal": normal, "low": low},
	}
}

// StageNames returns the names of all stages (unspecified order). For the
// future per-stage API to enumerate stages.
func (p *Pipeline) StageNames() []string {
	names := make([]string, 0, len(p.stages))
	for name := range p.stages {
		names = append(names, name)
	}
	return names
}

// HasStage reports whether a stage with the given name exists.
func (p *Pipeline) HasStage(name string) bool {
	_, ok := p.stages[name]
	return ok
}

// Status returns a per-stage status snapshot for every stage, keyed by name.
// Backs GET /api/admin/pipeline/status.
func (p *Pipeline) Status() map[string]interface{} {
	out := make(map[string]interface{}, len(p.stages))
	for name := range p.stages {
		out[name] = p.StageStatus(name)
	}
	return out
}

// SetStageConcurrency sets one stage's max concurrency. Returns false if the
// stage is unknown. Live effect on the running queue; not persisted (the
// pipelineConfig blob is the persistent source of truth, applied at startup).
func (p *Pipeline) SetStageConcurrency(name string, n int) bool {
	s, ok := p.stages[name]
	if !ok {
		return false
	}
	s.Queue.SetConcurrency(n)
	return true
}

// PauseStage pauses one stage's queue (admin control). Returns false if the
// stage is unknown.
func (p *Pipeline) PauseStage(name string) bool {
	s, ok := p.stages[name]
	if !ok {
		return false
	}
	s.Queue.Pause()
	return true
}

// ResumeStage resumes one stage's queue. Returns false if the stage is unknown.
func (p *Pipeline) ResumeStage(name string) bool {
	s, ok := p.stages[name]
	if !ok {
		return false
	}
	s.Queue.Resume()
	return true
}

// legacyStatus builds the aggregate /getIndexerStatus payload: the four
// cross-stage totals plus the full per-stage breakdown. It intentionally omits
// per-pipeline knobs that no longer have a single meaningful value under the
// staged model -- concurrency and paused are per-stage now (see each entry in
// "stages", and the /pipeline/status endpoint). The old Node-only "isDynamic"
// concept is dropped entirely (never implemented in Go).
func (p *Pipeline) legacyStatus() map[string]interface{} {
	stages := make(map[string]interface{}, len(p.stages))
	var totalPending, totalActive int
	var totalCompleted, totalFailed int64
	for name := range p.stages {
		st := p.StageStatus(name)
		stages[name] = st
		// Derive aggregate totals from the per-stage snapshot (single fetch).
		totalPending += st["pending"].(int)
		totalActive += st["active"].(int)
		totalCompleted += st["completed"].(int64)
		totalFailed += st["failed"].(int64)
	}
	return map[string]interface{}{
		"processingCnt": totalActive,
		"pendingCnt":    totalPending,
		"completedCnt":  totalCompleted,
		"failedCnt":     totalFailed,
		"stages":        stages,
	}
}

// aggregateErrors concatenates recent errors across all stages.
func (p *Pipeline) aggregateErrors() interface{} {
	var all []queue.Error
	for _, s := range p.stages {
		all = append(all, s.Queue.GetErrors()...)
	}
	return all
}

// submitEntry is the indexing.SubmitEntry hook: build a fresh item and enqueue
// it at the entry stage with Normal priority (orchestrator always uses Normal).
func (p *Pipeline) submitEntry(collection *collections.Collection, sourceFile, existingUUID string, inPlace bool) {
	item := &PipelineItem{
		Collection:   collection,
		SourceFile:   sourceFile,
		ExistingUUID: existingUUID,
		InPlace:      inPlace,
	}
	p.enqueueItem(p.entry, item, queue.Normal)
}

// submitRefresh is the indexing.SubmitRefresh hook: enqueue a metadata-only
// refresh onto the entry stage queue (it does not flow downstream). Runs at
// Normal priority.
func (p *Pipeline) submitRefresh(uuid, filename string) {
	uid, fn := uuid, filename
	p.entry.Queue.Enqueue(queue.Task{
		Priority:    queue.Normal,
		Description: "refresh:" + uid,
		Fn: func() error {
			return indexing.RefreshMetadata(uid, fn)
		},
	})
}
