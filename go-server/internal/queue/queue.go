package queue

import (
	"log/slog"
	"sync"
	"sync/atomic"
	"time"
)

// Priority levels for task scheduling.
type Priority int

const (
	High Priority = iota
	Normal
	Low
)

// maxErrors is the maximum number of recent errors to retain.
const maxErrors = 100

// eventBuffer is the per-subscriber channel buffer size. Events carry a full
// snapshot and sends are drop-oldest, so a small buffer suffices: a slow
// subscriber simply sees the latest state, never a stall.
const eventBuffer = 16

// TaskFn is a function executed by the queue.
type TaskFn func() error

// gate is a named dispatch condition. isOpen is evaluated at dispatch time; the
// queue does not interpret the name -- it is reported as the block reason when
// this is the first gate found closed. Owners register gates via RegisterGate.
type gate struct {
	name   string
	isOpen func() bool
}

// Task represents a unit of work with a priority level.
type Task struct {
	Fn          TaskFn
	Priority    Priority
	Description string
}

// Status represents the current state of the queue.
type Status struct {
	Pending        int   `json:"pending"`
	Active         int   `json:"active"`
	Completed      int64 `json:"completed"`
	Failed         int64 `json:"failed"`
	IsPaused       bool  `json:"is_paused"`
	MaxConcurrency int   `json:"max_concurrency"`

	// BlockReason is the name of the first closed gate seen at the last dispatch
	// attempt, or "" when the queue is not gate-blocked (all gates open, or no
	// gates, or there was no work to dispatch). It is a dispatch-time fact: an
	// idle queue with no pending work reports "" even if a gate would be closed,
	// because gate state is only meaningful when there is work to dispatch.
	BlockReason string `json:"block_reason"`
}

// Event is a snapshot of queue state emitted on every dispatch-cycle
// transition (enqueue, start, completion, pause, resume, concurrency change,
// and gate block/clear seen during a dispatch attempt). It carries a full
// Status snapshot, so a subscriber that drops intermediate events still
// converges on the latest truth. Subscribers are the pipeline orchestrator
// (kicks stages gated behind a drained upstream) and the SSE broadcaster.
type Event struct {
	Status Status
}

// Error records a failed task execution.
type Error struct {
	File      string    `json:"file"`
	ErrorMsg  string    `json:"error"`
	Timestamp time.Time `json:"timestamp"`
}

// Queue is a priority task queue with concurrency control.
type Queue struct {
	high   []Task
	normal []Task
	low    []Task
	mu     sync.Mutex

	sem            chan struct{} // buffered channel as concurrency semaphore
	active         atomic.Int32
	completed      atomic.Int64
	failed         atomic.Int64
	isPaused       atomic.Bool
	maxConcurrency int

	errors   []Error
	errorsMu sync.Mutex

	// gates is the ordered set of named dispatch conditions registered by their
	// owners (the queue does not know what any gate means). Dispatch requires
	// every gate open, evaluated as a short-circuit AND at dispatch time; the
	// first gate that returns false is the block reason. Order is preserved
	// (append order) so the block reason is deterministic. Guarded by q.mu so
	// gates can be re-registered at runtime (dynamic re-wire on config Apply)
	// without racing the dispatch loop's read.
	//
	// Gating never touches the paused flag; a gate-blocked queue is simply
	// declining to dispatch, not paused.
	gates []gate

	// blockReason is the name of the first closed gate seen at the last dispatch
	// attempt, or "" when not blocked. Updated inside the dispatch loop under
	// q.mu and surfaced via GetStatus / events. See Status.BlockReason.
	blockReason string

	// subscribers receive an Event snapshot on every dispatch-cycle transition.
	// Each send is non-blocking (drop-oldest): a slow subscriber never stalls
	// dispatch. Guarded by q.mu. Replaces the old onDrained callback -- the
	// orchestrator now watches the stream for an upstream's drained transition.
	subscribers []chan Event

	// gates replaces the old canDispatch predicate (SetCanDispatch); subscribers
	// replace the old onDrained callback (SetOnDrained). See the design doc
	// "Queue Gates, Events, and Live Status".

	notify chan struct{}
	done   chan struct{}
	logger *slog.Logger
}

// New creates a new Queue with the given maximum concurrency and starts
// the background dispatch goroutine.
func New(maxConcurrency int) *Queue {
	q := &Queue{
		sem:            make(chan struct{}, maxConcurrency),
		maxConcurrency: maxConcurrency,
		notify:         make(chan struct{}, 1),
		done:           make(chan struct{}),
		// Safe snapshot: New runs after main's initLogging, so this captures the
		// tint handler. Queue is a genuine class (multiple live instances), so it
		// stays a struct field. Only becomes unsafe if New were ever called at
		// package-var init time (before main) -- see docs/logger-init-order-bug.md.
		logger: slog.Default().With("component", "queue"),
	}
	go q.dispatch()
	return q
}

// RegisterGate adds a named dispatch condition. The dispatch loop evaluates all
// gates as a short-circuit AND before starting each task; the first gate whose
// isOpen returns false blocks dispatch and becomes the block reason. Gates are
// evaluated in registration order, so the block reason is deterministic.
// Guarded by q.mu so gates can be (re)registered at runtime without racing the
// dispatch loop. Owners call Kick when a gate's condition may have changed.
func (q *Queue) RegisterGate(name string, isOpen func() bool) {
	q.mu.Lock()
	q.gates = append(q.gates, gate{name: name, isOpen: isOpen})
	q.mu.Unlock()
}

// ClearGates removes all registered gates. Used for live re-wire on config
// Apply: clear, then re-register the gates for the new graph. A queue with no
// gates dispatches whenever !paused and a slot is free.
func (q *Queue) ClearGates() {
	q.mu.Lock()
	q.gates = nil
	q.blockReason = ""
	q.mu.Unlock()
}

// Subscribe returns a channel that receives an Event snapshot on every
// dispatch-cycle transition. The channel is buffered and sends are
// non-blocking (drop-oldest): a slow consumer never stalls the queue, and
// because each Event carries a full snapshot, dropping intermediates is safe.
// Subscribers are not unsubscribed individually; they are released when the
// queue is stopped. (The pipeline rebuilds its subscriptions by replacing the
// queue set on the rare config Apply; see the orchestrator.)
func (q *Queue) Subscribe() <-chan Event {
	ch := make(chan Event, eventBuffer)
	q.mu.Lock()
	q.subscribers = append(q.subscribers, ch)
	q.mu.Unlock()
	return ch
}

// evalGates returns the name of the first closed gate (block reason), or "" if
// every gate is open. Caller must NOT hold q.mu: gate isOpen funcs may call
// back into queue methods (e.g. an upstream's GetStatus) and must not deadlock.
// It snapshots the gate slice under the lock, then evaluates outside it.
func (q *Queue) evalGates() string {
	q.mu.Lock()
	gates := q.gates
	q.mu.Unlock()
	for _, g := range gates {
		if !g.isOpen() {
			return g.name
		}
	}
	return ""
}

// setBlockReason records the current block reason under the lock and reports
// whether it changed (so the dispatch loop can emit an event only on a real
// block/clear transition, not on every attempt).
func (q *Queue) setBlockReason(reason string) (changed bool) {
	q.mu.Lock()
	changed = q.blockReason != reason
	q.blockReason = reason
	q.mu.Unlock()
	return changed
}

// emit sends the current status snapshot to all subscribers, non-blocking
// (drop-oldest). Called on every dispatch-cycle transition.
func (q *Queue) emit() {
	status := q.GetStatus()
	q.mu.Lock()
	subs := q.subscribers
	q.mu.Unlock()
	for _, ch := range subs {
		// Non-blocking send with drop-oldest: if the buffer is full, discard the
		// oldest queued event and enqueue the newest, so a slow subscriber always
		// converges on the latest snapshot without stalling the queue.
		select {
		case ch <- Event{Status: status}:
		default:
			select {
			case <-ch:
			default:
			}
			select {
			case ch <- Event{Status: status}:
			default:
			}
		}
	}
}

// Kick nudges the dispatch loop to re-evaluate pending work (e.g. after a gated
// upstream drains). Non-blocking.
func (q *Queue) Kick() {
	select {
	case q.notify <- struct{}{}:
	default:
	}
}

// Enqueue adds a single task to the queue according to its priority.
func (q *Queue) Enqueue(task Task) {
	q.mu.Lock()
	switch task.Priority {
	case High:
		q.high = append(q.high, task)
	case Low:
		q.low = append(q.low, task)
	default:
		q.normal = append(q.normal, task)
	}
	q.mu.Unlock()

	// Signal the dispatch loop (non-blocking).
	select {
	case q.notify <- struct{}{}:
	default:
	}
	q.emit()
}

// EnqueueMany adds multiple tasks to the queue in bulk.
func (q *Queue) EnqueueMany(tasks []Task) {
	q.mu.Lock()
	for _, task := range tasks {
		switch task.Priority {
		case High:
			q.high = append(q.high, task)
		case Low:
			q.low = append(q.low, task)
		default:
			q.normal = append(q.normal, task)
		}
	}
	q.mu.Unlock()

	select {
	case q.notify <- struct{}{}:
	default:
	}
	q.emit()
}

// Pause stops the queue from dispatching new tasks. Already running tasks
// continue to completion.
func (q *Queue) Pause() {
	q.isPaused.Store(true)
	q.logger.Info("queue paused")
	q.emit()
}

// Resume allows the queue to dispatch tasks again.
func (q *Queue) Resume() {
	q.isPaused.Store(false)
	q.logger.Info("queue resumed")

	// Kick the dispatch loop.
	select {
	case q.notify <- struct{}{}:
	default:
	}
	q.emit()
}

// SetConcurrency changes the maximum number of concurrent tasks.
// It replaces the semaphore channel. Active tasks finish with the old
// semaphore; new dispatches use the new one.
func (q *Queue) SetConcurrency(n int) {
	if n < 1 {
		n = 1
	}
	q.mu.Lock()
	q.maxConcurrency = n
	q.sem = make(chan struct{}, n)
	q.mu.Unlock()

	q.logger.Info("concurrency updated", "max_concurrency", n)

	// Kick the dispatch loop to take advantage of new capacity.
	select {
	case q.notify <- struct{}{}:
	default:
	}
	q.emit()
}

// GetStatus returns the current queue status.
func (q *Queue) GetStatus() Status {
	q.mu.Lock()
	pending := len(q.high) + len(q.normal) + len(q.low)
	blockReason := q.blockReason
	q.mu.Unlock()

	return Status{
		Pending:        pending,
		Active:         int(q.active.Load()),
		Completed:      q.completed.Load(),
		Failed:         q.failed.Load(),
		IsPaused:       q.isPaused.Load(),
		MaxConcurrency: q.maxConcurrency,
		BlockReason:    blockReason,
	}
}

// QueueSizes returns the number of pending tasks at each priority level.
func (q *Queue) QueueSizes() (high, normal, low int) {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.high), len(q.normal), len(q.low)
}

// GetErrors returns the most recent errors (up to maxErrors).
func (q *Queue) GetErrors() []Error {
	q.errorsMu.Lock()
	defer q.errorsMu.Unlock()

	result := make([]Error, len(q.errors))
	copy(result, q.errors)
	return result
}

// Stop signals the dispatch goroutine to exit. Blocks until it has stopped.
func (q *Queue) Stop() {
	close(q.done)
}

// dispatch is the background loop that dequeues tasks and runs them
// within the concurrency limit.
func (q *Queue) dispatch() {
	for {
		select {
		case <-q.done:
			return
		case <-q.notify:
			q.drainQueue()
		}
	}
}

// drainQueue attempts to dispatch all pending tasks up to the concurrency limit.
func (q *Queue) drainQueue() {
	for {
		// Respect pause state.
		if q.isPaused.Load() {
			return
		}

		// Evaluate gates: if any gate is closed, leave tasks pending and stop
		// draining. We will be re-kicked via Kick() when a gate owner's condition
		// may have changed (or on the next notify). Checked before dequeue so a
		// task is not pulled out of the queue while blocked. The first closed
		// gate is the block reason; record it and emit an event only on a
		// block/clear transition (not on every attempt).
		//
		// The block reason is only meaningful when there is work to dispatch, so
		// only evaluate (and only report a reason) when something is pending; an
		// empty queue is just "idle" with block reason "". evalGates must run
		// without q.mu held (a gate's isOpen may call back into queue methods).
		q.mu.Lock()
		hasPending := len(q.high)+len(q.normal)+len(q.low) > 0
		q.mu.Unlock()
		if hasPending {
			if reason := q.evalGates(); reason != "" {
				if q.setBlockReason(reason) {
					q.emit()
				}
				return
			}
			// All gates open: clear any prior block reason (emit on the clearing
			// transition so subscribers see the unblock).
			if q.setBlockReason("") {
				q.emit()
			}
		}

		// Check if stopped.
		select {
		case <-q.done:
			return
		default:
		}

		task, ok := q.dequeue()
		if !ok {
			return
		}

		// Acquire a concurrency slot WITHOUT blocking. If the queue is at its
		// limit, put the task back and stop draining; a task completion (which
		// frees a slot and kicks q.notify) will re-drive the loop. Blocking here
		// would be a bug: a task dequeued and parked on a full semaphore would
		// later start even if the queue was paused in the meantime, breaking
		// both the pause guarantee and the concurrency cap (rapid pause/resume
		// could then run more tasks than maxConcurrency).
		q.mu.Lock()
		sem := q.sem
		q.mu.Unlock()

		select {
		case sem <- struct{}{}:
			// Got a slot.
		default:
			// At capacity: return the task and wait to be re-kicked.
			q.requeueFront(task)
			return
		}

		// Re-check pause/stop AFTER acquiring the slot but BEFORE launching, so a
		// pause (or Stop) that landed while we were between the top-of-loop check
		// and the acquire does not let this task start. Release the slot and
		// requeue if so.
		if q.isPaused.Load() {
			<-sem
			q.requeueFront(task)
			return
		}
		select {
		case <-q.done:
			<-sem
			q.requeueFront(task)
			return
		default:
		}

		q.active.Add(1)
		q.emit() // task started: counters changed

		go func(t Task, s chan struct{}) {
			defer func() {
				<-s
				q.active.Add(-1)

				// Emit a completion event. Subscribers (the orchestrator, the SSE
				// broadcaster) read the full snapshot and act on it: the
				// orchestrator kicks stages gated behind this queue when it sees
				// the busy->drained transition (Active==0 && Pending==0). We emit
				// on every completion rather than only on the drained edge; the
				// snapshot is cheap, subscribers coalesce, and the orchestrator's
				// drained check is idempotent (an extra kick just re-evaluates a
				// gate). This replaces the old onDrained callback.
				q.emit()

				// Kick the dispatch loop in case more tasks are pending.
				select {
				case q.notify <- struct{}{}:
				default:
				}
			}()

			err := t.Fn()
			if err != nil {
				q.failed.Add(1)
				q.recordError(t.Description, err)
				q.logger.Error("task failed", "description", t.Description, "error", err)
			} else {
				q.completed.Add(1)
			}
		}(task, sem)
	}
}

// requeueFront returns a previously-dequeued task to the FRONT of its own
// priority lane, so it is the next candidate on the following drain. Used when
// a task was dequeued but cannot be started right now (at capacity, paused, or
// stopping), to avoid losing it or reordering priorities.
func (q *Queue) requeueFront(task Task) {
	q.mu.Lock()
	switch task.Priority {
	case High:
		q.high = append([]Task{task}, q.high...)
	case Low:
		q.low = append([]Task{task}, q.low...)
	default:
		q.normal = append([]Task{task}, q.normal...)
	}
	q.mu.Unlock()
}

// dequeue removes and returns the highest priority task available.
// Returns false if no tasks are pending.
func (q *Queue) dequeue() (Task, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()

	if len(q.high) > 0 {
		task := q.high[0]
		q.high = q.high[1:]
		return task, true
	}
	if len(q.normal) > 0 {
		task := q.normal[0]
		q.normal = q.normal[1:]
		return task, true
	}
	if len(q.low) > 0 {
		task := q.low[0]
		q.low = q.low[1:]
		return task, true
	}

	return Task{}, false
}

// recordError appends an error to the errors slice, trimming to maxErrors.
func (q *Queue) recordError(description string, err error) {
	q.errorsMu.Lock()
	defer q.errorsMu.Unlock()

	q.errors = append(q.errors, Error{
		File:      description,
		ErrorMsg:  err.Error(),
		Timestamp: time.Now(),
	})

	if len(q.errors) > maxErrors {
		q.errors = q.errors[len(q.errors)-maxErrors:]
	}
}
