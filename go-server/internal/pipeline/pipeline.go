// Package pipeline is the indexing orchestrator. It owns a set of work queues
// (one per stage, the "node" master list), the fixed data-flow routing between
// them (bring-to-collection -> thumbnails -> ML, plus geo and video branches),
// and a set of gaters that decide when each queue may dispatch. Routing is a
// pipeline concern expressed over queue names (routeDownstreams); gating is
// delegated to gaters (resource scheduling by resourceGater, geo rate limiting
// by the geo rate gater) so the pipeline does not know how any gate is
// computed. See docs/pipeline-dag-design.md.
package pipeline

import (
	"log/slog"
	"sync"

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
	stages map[string]*node
	entry  *node

	// gateMu guards the mutable, config-driven state the pipeline itself owns
	// and that Apply rewrites at runtime: each node's Enabled flag (read by
	// routing). The resource-gating model is owned by the resourceGater, which
	// guards it with its own lock. Hot-path routing readers take RLock; Apply
	// takes Lock. The node set and the data-flow routing table are fixed after
	// construction and need no lock.
	gateMu sync.RWMutex

	// gaters are the dispatch-gating strategies attached to the queues. The
	// pipeline owns the queues and the set of gaters, and wires each gater onto
	// the queues it governs; it does not know how any gater computes its
	// condition. Today: the resource gater (below). Sub-step C adds the geo
	// rate gater.
	gaters []Gater
	// resource is the resource-scheduling gater (kept as a typed reference for
	// the live Apply re-wire, which rebuilds its GatedBy model).
	resource *resourceGater
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

// queueFactory creates a Queue for a stage with the given name and concurrency.
// Production uses realQueueFactory (a *queue.Queue); tests inject fakes. The
// name is carried on the queue's events so the SSE layer can identify the stage.
type queueFactory func(name string, concurrency int) Queue

// realQueueFactory builds a real work queue named for its stage.
func realQueueFactory(name string, concurrency int) Queue { return queue.New(name, concurrency) }

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
	p := &Pipeline{stages: make(map[string]*node)}
	p.buildNodes(funcs, cfg, qf)
	// Resource gating is a Gater over the queues; build it from the config's
	// gatedBy edges and the pipeline's queue-busy lookup, then attach.
	p.resource = newResourceGater(gatedByMap(cfg), p.queueBusy)
	p.gaters = []Gater{p.resource}
	p.wireGates()
	return p
}

// queueByName implements gateHost: look up a stage's queue by name (nil if
// unknown). The stage set is fixed after construction, so no lock is needed.
func (p *Pipeline) queueByName(name string) Queue {
	if s, ok := p.stages[name]; ok {
		return s.Queue
	}
	return nil
}

// queueBusy reports whether the named queue has running or pending work. The
// resource gater uses it to evaluate upstream busyness.
func (p *Pipeline) queueBusy(name string) bool {
	q := p.queueByName(name)
	if q == nil {
		return false
	}
	st := q.GetStatus()
	return st.Active > 0 || st.Pending > 0
}

// gatedByMap extracts the resource-gating edges from a config as a queue-name
// map: queue name -> gating upstream queue names. This is the resource gater's
// input, independent of the Stage type.
func gatedByMap(cfg PipelineConfig) map[string][]string {
	m := make(map[string][]string)
	for _, sc := range cfg.Stages {
		if len(sc.GatedBy) > 0 {
			ups := make([]string, len(sc.GatedBy))
			copy(ups, sc.GatedBy)
			m[sc.Name] = ups
		}
	}
	return m
}

// buildNodes constructs the queue master list (one node per stage, with its
// concurrency + enable flag from config) and the fixed data-flow routing table.
// Routing (which queue feeds which) is a pipeline concern expressed over queue
// names; resource gating is NOT built here (the resourceGater owns it, from
// gatedByMap). Queues are created via qf.
func (p *Pipeline) buildNodes(funcs stageFuncs, cfg PipelineConfig, qf queueFactory) {
	byName := cfg.byName()
	newNode := func(name string, fn StageFn) *node {
		sc := byName[name]
		n := &node{
			Name:    name,
			Fn:      fn,
			Queue:   qf(name, sc.concurrency()),
			Enabled: sc.enabled(),
		}
		p.stages[name] = n
		return n
	}

	// Create all nodes (concurrency + enable applied from config).
	newNode(StageGeoLookup, funcs.geoLookup)
	newNode(StageFaceRecognition, funcs.faceRecognition)
	newNode(StageImageEncoding, funcs.imageEncoding)
	newNode(StageVideoCompression, funcs.videoCompression)
	newNode(StageImageThumbnails, funcs.imageThumbnails)
	newNode(StageVideoThumbnail, funcs.videoThumbnail)
	p.entry = newNode(StageBringToCollection, funcs.bringToCollection)

	// Data flow is expressed over queue names by routeDownstreams (a pipeline
	// method), which also applies the per-item conditionals (media type, GPS,
	// ML availability, enable flag). There is no separate stored table: the
	// routing graph is small and fixed, and keeping it as code next to the
	// conditionals avoids a redundant candidate-set field that could drift.
}

// wireGates attaches every gater to the queues it governs. Each gater
// registers its gate and sets up its own kicking; the pipeline does not know
// how any gater computes its condition. Called at startup and on every live
// Apply (gaters' Attach is idempotent).
func (p *Pipeline) wireGates() {
	for _, g := range p.gaters {
		g.Attach(p)
	}
}

// Apply re-applies a pipeline config to the RUNNING pipeline without a restart:
// per-stage Enabled, concurrency, and the gate graph (GatedBy) are updated in
// place, then the gate hooks are re-wired and every stage queue kicked so it
// re-evaluates its gate immediately.
//
// Semantics (see design discussion):
//   - Nothing running is killed; gating only affects what is *dispatched* next.
//   - A newly-gated stage stops starting new tasks right away (its in-flight
//     tasks finish); a newly-ungated stage may start immediately.
//   - The config is validated first; on any validation error the running
//     pipeline is left completely unchanged (atomic reject).
//
// It also persists the applied (canonical) config so it survives restart.
func (p *Pipeline) Apply(cfg PipelineConfig) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	p.applyLive(cfg)
	if err := persistConfig(cfg); err != nil {
		// The live state is already updated; report the persistence failure so
		// the caller knows it will not survive a restart.
		return err
	}
	plLogger().Info("pipeline config applied live")
	return nil
}

// applyLive performs the in-place re-apply (enable, concurrency, gate graph,
// re-wire, kick) without validation or persistence. cfg is assumed valid.
// Separated from Apply so tests can exercise the live re-wire without a DB.
func (p *Pipeline) applyLive(cfg PipelineConfig) {
	byName := cfg.byName()

	// Update per-node Enabled (routing) and concurrency under the pipeline's
	// lock. Resource gating is not on the node anymore -- the resource gater
	// owns it and is rebuilt below from the new config.
	p.gateMu.Lock()
	for name, s := range p.stages {
		sc := byName[name]
		s.Enabled = sc.enabled()
		// Only resize the queue when concurrency actually changes: SetConcurrency
		// replaces the semaphore, so calling it needlessly on every apply churns
		// the dispatch path.
		if n := sc.concurrency(); n != s.Queue.GetStatus().MaxConcurrency {
			s.Queue.SetConcurrency(n)
		}
	}
	p.gateMu.Unlock()

	// Rebuild the resource gater's model from the new config and re-attach all
	// gaters (idempotent: clears + re-registers each gater's gate, restarts
	// kicking). Done outside gateMu since the gater owns its own lock.
	p.resource.rebuild(gatedByMap(cfg))
	p.wireGates()

	// Kick every stage so a stage that just became ungated (or whose gate is
	// already open) re-evaluates and dispatches any pending work immediately.
	for _, s := range p.stages {
		s.Queue.Kick()
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

// StopAll stops every stage's dispatch goroutine (shutdown) and tears down each
// gater (e.g. the resource gater's drained-event subscribers).
func (p *Pipeline) StopAll() {
	p.resource.Stop()
	for _, s := range p.stages {
		s.Queue.Stop()
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
	// The block reason now comes straight from the queue (the first closed gate
	// seen at the last dispatch attempt). "gatedClosed" is the resource-gate
	// view the UI already consumes: true when the queue is blocked by the
	// "resource" gate. blockReason exposes the raw gate name for finer display
	// (e.g. "rate" once geo registers its gate). The pipeline no longer
	// recomputes upstreamBusy() for the UI.
	gatedClosed := st.BlockReason == "resource"
	return map[string]interface{}{
		"stage":          name,
		"pending":        st.Pending,
		"active":         st.Active,
		"completed":      st.Completed,
		"failed":         st.Failed,
		"paused":         st.IsPaused,
		"maxConcurrency": st.MaxConcurrency,
		"gatedClosed":    gatedClosed,
		"blockReason":    st.BlockReason,
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
