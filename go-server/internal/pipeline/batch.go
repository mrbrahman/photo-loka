package pipeline

import (
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"photo-loka/internal/queue"
)

// Batch lifecycle detection.
//
// The Node.js indexer was a single queue, so "a batch" was just that queue
// going idle -> busy -> idle: start_batch fired on the idle->busy edge and
// all_done on the busy->idle edge (logging the elapsed time). The Go pipeline
// is a graph of ~10 stage queues that hand work to each other and is agnostic
// to which collection an item belongs to, so "a batch" is an emergent property
// across all queues, not a single queue's counters.
//
// batchWatcher reconstructs that lifecycle:
//
//   - A batch is OPENED by the first submitEntry (a NEW item entering the
//     pipeline) while no batch is open. Pure metadata refreshes / standalone
//     stage re-runs keep the queues busy but do NOT open a "new items" batch,
//     so a refresh-only burst produces no notification. Each submitEntry also
//     records its collection id into the open batch (the pipeline is otherwise
//     collection-agnostic, but the eventual notification's click-through search
//     is collection-scoped, so we must know which collections participated).
//
//   - A batch is CLOSED on the aggregate busy->idle edge: every stage queue has
//     Active==0 && Pending==0. Because stages hand off to each other, the
//     aggregate can read idle for a brief instant mid-batch (one stage drained,
//     the next not yet dispatched), so the close is debounced by a quiet period
//     (quietPeriod): the busy->idle edge arms a timer, and the batch only
//     closes if the pipeline stays idle for the whole window. Any activity
//     before it fires cancels the pending close (same batch continues).
//
// On close the watcher logs (restoring Node parity) and invokes onBatchEnded
// with the batch's collection-id set. There is exactly one pipeline, so the
// watcher is a single collaborator the pipeline owns (constructed in
// newPipelineWithQueues, torn down in StopAll) -- it is not a public singleton.
// It is a struct because it has real mutable state and a subscribe/stop
// lifecycle, mirroring the gaters.

// quietPeriod is how long the aggregate must stay idle after the busy->idle
// edge before a batch is considered ended. It bridges the sub-second all-idle
// gaps between stage handoffs (a stage draining before its downstream has
// dispatched) so one logical indexing run is reported as one batch, not many.
// Not configurable yet; promote to runtime-config if real-world handoffs prove
// slower than this.
const quietPeriod = 2 * time.Second

// BatchEnded describes one completed indexing batch (opened by a new item,
// closed by the aggregate busy->idle edge after the quiet period). It is the
// signal Bit 3 (the push sender) consumes to raise one notification per
// participating collection. Bit 1 only logs it and invokes the callback.
type BatchEnded struct {
	StartedAt     time.Time
	EndedAt       time.Time
	CollectionIDs []int64 // collections that had a new item enter during the batch
}

// batchWatcher tracks the aggregate busy state across all stage queues and the
// collection ids of the current batch, emitting a BatchEnded on each
// busy->idle (debounced) edge of an open batch.
type batchWatcher struct {
	// onBatchEnded is invoked once per closed batch. nil until wired; a nil
	// callback means the watcher still logs but notifies no one. Stored
	// atomically because it is set by Init on the startup goroutine after the
	// run goroutine has already started (production sets it before any batch can
	// open, but the atomic keeps the set/read race-free regardless).
	onBatchEnded atomic.Pointer[func(BatchEnded)]

	// now is injectable for deterministic elapsed assertions in tests; in
	// production it is time.Now. The quiet-period close uses real timers (quiet,
	// below) rather than a faked clock, matching the existing pipeline tests
	// (short durations + polling).
	now func() time.Time

	// quiet is the idle window before a busy->idle edge closes a batch. Defaults
	// to quietPeriod; tests set a short value for speed.
	quiet time.Duration

	// onStep, if non-nil, is called by the run goroutine after it processes each
	// input (an activity signal or a queue event). It is a TEST-ONLY seam that
	// lets a test block until a specific input has been fully applied, making
	// the otherwise-unordered activity vs. event channels deterministic. nil in
	// production.
	onStep func()

	// activity carries submitEntry signals (a new item + its collection id)
	// into the watcher goroutine, which owns all batch state with no lock.
	activity chan int64

	stop chan struct{}
	wg   sync.WaitGroup

	// busyByQueue is the watcher goroutine's local view of each queue's
	// busyness, updated from that queue's events. The aggregate is the OR over
	// this map. Owned solely by the run goroutine (no lock).
	busyByQueue map[string]bool

	// open batch state, owned solely by the run goroutine.
	batchOpen bool
	startedAt time.Time
	collIDs   map[int64]struct{}
}

// newBatchWatcher builds a watcher with production clock/timer. Wire the
// callback via setOnBatchEnded before (or after) start; a nil callback is safe.
func newBatchWatcher() *batchWatcher {
	return &batchWatcher{
		now:         time.Now,
		quiet:       quietPeriod,
		activity:    make(chan int64, 64),
		stop:        make(chan struct{}),
		busyByQueue: make(map[string]bool),
		collIDs:     make(map[int64]struct{}),
	}
}

// setOnBatchEnded sets the batch-end callback. Safe to call before or after
// start (the pointer is stored atomically).
func (w *batchWatcher) setOnBatchEnded(fn func(BatchEnded)) { w.onBatchEnded.Store(&fn) }

// noteEntry records that a new item for collectionID entered the pipeline. Call
// from submitEntry. Non-blocking: if the buffer is briefly full the signal is
// dropped, which at worst omits one collection id from the batch set (the batch
// still opens/closes on queue busyness). The buffer is large enough that this
// is effectively never hit.
func (w *batchWatcher) noteEntry(collectionID int64) {
	select {
	case w.activity <- collectionID:
	default:
	}
}

// start subscribes to every stage queue's event stream and launches the single
// watcher goroutine. Called once at construction time (newPipelineWithQueues),
// after the stages exist.
func (w *batchWatcher) start(srcs []<-chan queue.Event) {
	w.wg.Add(1)
	go w.run(srcs)
}

// run is the watcher's single goroutine: it owns all batch state. It merges the
// per-queue event streams and the submitEntry activity channel, maintaining the
// aggregate busy view and the open batch, and arming/canceling the quiet-period
// close timer on the aggregate busy<->idle transitions.
func (w *batchWatcher) run(srcs []<-chan queue.Event) {
	defer w.wg.Done()

	// Fan the per-queue event streams into one channel so the single select
	// below can also watch activity/stop/timer. One forwarder goroutine per
	// source, torn down on stop.
	merged := make(chan queue.Event, eventChanBuffer)
	var fwdWG sync.WaitGroup
	for _, src := range srcs {
		src := src
		fwdWG.Add(1)
		go func() {
			defer fwdWG.Done()
			for {
				select {
				case <-w.stop:
					return
				case ev, ok := <-src:
					if !ok {
						return
					}
					select {
					case merged <- ev:
					case <-w.stop:
						return
					}
				}
			}
		}()
	}

	// closeTimer is non-nil only while a close is pending (aggregate idle, batch
	// open, waiting out the quiet period). timerC mirrors it for selecting.
	var closeTimer *time.Timer
	var timerC <-chan time.Time
	disarm := func() {
		if closeTimer != nil {
			closeTimer.Stop()
			closeTimer = nil
			timerC = nil
		}
	}

	for {
		select {
		case <-w.stop:
			disarm()
			// Forwarders select on w.stop too, so they are already unblocking;
			// wait for them so no goroutine lingers past StopAll. They never
			// block on `merged` because their send also selects on w.stop.
			fwdWG.Wait()
			return

		case collID := <-w.activity:
			// A new item entered. Open a batch if none is open, and record the
			// collection. New activity also cancels any pending close (the
			// pipeline is about to be busy again).
			disarm()
			if !w.batchOpen {
				w.batchOpen = true
				w.startedAt = w.now()
				w.collIDs = make(map[int64]struct{})
				plLogger().Info("indexer batch started")
			}
			w.collIDs[collID] = struct{}{}
			if w.onStep != nil {
				w.onStep()
			}

		case ev := <-merged:
			w.busyByQueue[ev.Name] = ev.Status.Active > 0 || ev.Status.Pending > 0
			if w.aggregateBusy() {
				// Busy again: cancel any pending close.
				disarm()
			} else if w.batchOpen && closeTimer == nil {
				// Just went (or confirmed) idle with a batch open: arm the
				// quiet-period close. If it survives the window, the batch ends.
				closeTimer = time.NewTimer(w.quiet)
				timerC = closeTimer.C
			}
			if w.onStep != nil {
				w.onStep()
			}

		case <-timerC:
			// Quiet period elapsed with the pipeline still idle: close the batch.
			closeTimer = nil
			timerC = nil
			w.closeBatch()
		}
	}
}

// aggregateBusy reports whether any queue is currently busy per the watcher's
// local view.
func (w *batchWatcher) aggregateBusy() bool {
	for _, busy := range w.busyByQueue {
		if busy {
			return true
		}
	}
	return false
}

// closeBatch finalizes the open batch: snapshot its collection ids, log the
// elapsed time (Node parity), reset state, and invoke the callback. A no-op if
// no batch is open (defensive; the caller only calls it with one open).
func (w *batchWatcher) closeBatch() {
	if !w.batchOpen {
		return
	}
	ended := w.now()
	ids := make([]int64, 0, len(w.collIDs))
	for id := range w.collIDs {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })

	w.batchOpen = false
	w.collIDs = make(map[int64]struct{})

	plLogger().Info("finished indexer batch",
		"elapsed", ended.Sub(w.startedAt).String(),
		"collections", ids,
	)

	if fn := w.onBatchEnded.Load(); fn != nil {
		(*fn)(BatchEnded{
			StartedAt:     w.startedAt,
			EndedAt:       ended,
			CollectionIDs: ids,
		})
	}
}

// Stop tears down the watcher goroutine and its forwarders. Blocks until the
// run goroutine has exited.
func (w *batchWatcher) Stop() {
	close(w.stop)
	w.wg.Wait()
}
