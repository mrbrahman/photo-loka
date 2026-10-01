// Package pipeline is the indexing orchestrator. It wires the fixed media data
// flow (bring-to-collection -> thumbnails -> ML, plus geo and video branches)
// as a set of Stage instances, each backed by its own queue.Queue. Data flow
// (Downstreams) is hardcoded here; resource gating (GatedBy) is layered on in a
// later phase from config. See docs/pipeline-dag-design.md.
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
	stages map[string]*Stage
	entry  *Stage

	// gateMu guards the mutable, config-driven gate state that Apply rewrites at
	// runtime: each Stage's GatedBy and Enabled, the queue gates set by
	// wireGates, and the subscriber generation below. Hot-path readers (the
	// resource gate's isOpen via upstreamBusy, and routing's Enabled checks)
	// take RLock; Apply takes Lock. The stage set and data-flow Downstreams are
	// fixed after construction and need no lock.
	gateMu sync.RWMutex

	// gateSubsStop is closed to signal the current generation of drained-event
	// subscriber goroutines (started by wireGates) to exit. wireGates replaces
	// it with a fresh channel each time it runs, so a live Apply tears down the
	// old subscriptions and starts new ones without leaking goroutines. Guarded
	// by gateMu (written in wireGates, which callers invoke under gateMu.Lock).
	gateSubsStop chan struct{}
	// gateSubsWG tracks the current subscriber goroutines so StopAll (and tests)
	// can wait for them to exit.
	gateSubsWG sync.WaitGroup
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

// wireGates installs each gated stage's "resource" gate and starts the
// drained-event subscribers that kick dependents when an upstream drains.
//
// wireGates is called both at startup and on every live Apply, so it must be
// idempotent: first clear ALL gates (so a stage that is no longer gated stops
// declining dispatch) and stop the previous generation of subscriber goroutines,
// then register gates and start fresh subscribers for the currently-gated graph.
// Callers hold p.gateMu for writing; the gate isOpen closures run later on
// dispatch goroutines and take p.gateMu.RLock themselves.
func (p *Pipeline) wireGates() {
	// Tear down the previous subscriber generation (if any) and wait for it to
	// exit, so re-wiring never leaks goroutines and old subscribers cannot kick
	// using a stale dependents map.
	if p.gateSubsStop != nil {
		close(p.gateSubsStop)
		p.gateSubsWG.Wait()
	}
	p.gateSubsStop = make(chan struct{})
	stop := p.gateSubsStop

	// Clear all gates first (idempotent re-wire).
	for _, s := range p.stages {
		s.Queue.ClearGates()
	}

	// Register the "resource" gate on each gated stage and build the reverse
	// index upstream -> stages gated behind it, so an upstream's drained event
	// knows whom to kick.
	dependents := make(map[*Stage][]*Stage)
	for _, s := range p.stages {
		stage := s
		if len(stage.GatedBy) > 0 {
			// The gate reads GatedBy (via upstreamBusy) at dispatch time; take
			// the read lock so a concurrent Apply cannot race the swap.
			stage.Queue.RegisterGate("resource", func() bool {
				p.gateMu.RLock()
				busy := stage.upstreamBusy()
				p.gateMu.RUnlock()
				return !busy
			})
			for _, up := range stage.GatedBy {
				dependents[up] = append(dependents[up], stage)
			}
		}
	}

	// For each upstream that gates something, subscribe to its event stream and
	// kick the dependents on its busy->drained transition. One goroutine per
	// such upstream; all exit when stop is closed (next re-wire or StopAll).
	for up, gated := range dependents {
		upstream := up
		kickees := gated
		ch := upstream.Queue.Subscribe()
		p.gateSubsWG.Add(1)
		go func() {
			defer p.gateSubsWG.Done()
			// Track drained state so we kick only on the busy->drained edge, not
			// on every event. An upstream starts drained; real work un-drains it.
			wasDrained := true
			for {
				select {
				case <-stop:
					return
				case ev, ok := <-ch:
					if !ok {
						return
					}
					nowDrained := ev.Status.Active == 0 && ev.Status.Pending == 0
					if nowDrained && !wasDrained {
						for _, g := range kickees {
							g.Queue.Kick()
						}
					}
					wasDrained = nowDrained
				}
			}
		}()
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

	p.gateMu.Lock()
	// Update enable flag and gate edges per stage. Concurrency is applied via
	// the queue (its own lock); safe to call under gateMu (no lock inversion).
	for name, s := range p.stages {
		sc := byName[name]
		s.Enabled = sc.enabled()
		// Only resize the queue when concurrency actually changes: SetConcurrency
		// replaces the semaphore, so calling it needlessly on every apply churns
		// the dispatch path.
		if n := sc.concurrency(); n != s.Queue.GetStatus().MaxConcurrency {
			s.Queue.SetConcurrency(n)
		}
		// Rebuild GatedBy from scratch (a stage may have lost gates).
		s.GatedBy = nil
	}
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
	// Re-point the gate hooks to match the new graph (idempotent; clears hooks
	// on stages that are no longer gated).
	p.wireGates()
	p.gateMu.Unlock()

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

// StopAll stops every stage's dispatch goroutine (shutdown) and tears down the
// gate drained-event subscribers.
func (p *Pipeline) StopAll() {
	p.gateMu.Lock()
	if p.gateSubsStop != nil {
		close(p.gateSubsStop)
		p.gateSubsStop = nil
	}
	p.gateMu.Unlock()
	p.gateSubsWG.Wait()
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
