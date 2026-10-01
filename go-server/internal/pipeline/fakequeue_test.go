package pipeline

import (
	"sync"

	"photo-loka/internal/queue"
)

// fakeQueue is a test double for the pipeline's Queue interface. It runs no
// goroutines: the test sets the reported busy state (active/pending) directly
// and inspects the gate the pipeline registers and the events it subscribes to.
// This lets orchestrator tests exercise gating logic deterministically, without
// the real queue's dispatch timing (which is covered by queue_test.go).
type fakeQueue struct {
	mu      sync.Mutex
	name    string
	active  int
	pending int

	// gates holds the gates the pipeline registered via RegisterGate, in order.
	// The pipeline registers a single "resource" gate on each gated stage.
	gates []fakeGate
	// subscribers are the channels handed out by Subscribe; fireDrained/emit
	// push Events to them to simulate the real queue's event stream.
	subscribers []chan queue.Event

	kicks    int
	enqueued []queue.Task
	paused   bool
	stopped  bool
	maxConc  int
}

type fakeGate struct {
	name   string
	isOpen func() bool
}

func newFakeQueue() *fakeQueue { return &fakeQueue{maxConc: 1} }

// setBusy sets the reported running/pending counts (what upstreamBusy reads).
func (f *fakeQueue) setBusy(active, pending int) {
	f.mu.Lock()
	f.active, f.pending = active, pending
	f.mu.Unlock()
}

// fireDrained emits a busy->drained transition on the event stream: first a
// busy snapshot, then a drained snapshot (Active==0 && Pending==0). The
// orchestrator's subscriber kicks gated dependents only on the busy->drained
// edge, so both events are needed to drive it. Sends are non-blocking (like the
// real queue's drop-oldest emit) so a torn-down subscriber (after a re-wire)
// does not block the test. Delivery/kick is asynchronous (the subscriber runs
// in its own goroutine), so tests poll kick counts with waitFor.
func (f *fakeQueue) fireDrained() {
	f.mu.Lock()
	subs := append([]chan queue.Event(nil), f.subscribers...)
	f.mu.Unlock()
	busy := queue.Event{Status: queue.Status{Active: 1, Pending: 0}}
	drained := queue.Event{Status: queue.Status{Active: 0, Pending: 0}}
	for _, ch := range subs {
		for _, ev := range []queue.Event{busy, drained} {
			select {
			case ch <- ev:
			default:
			}
		}
	}
}

// dispatchAllowed evaluates the gates the pipeline registered (the "resource"
// gate). Returns true if no gate was registered (ungated) or all gates are open.
func (f *fakeQueue) dispatchAllowed() bool {
	f.mu.Lock()
	gates := append([]fakeGate(nil), f.gates...)
	f.mu.Unlock()
	for _, g := range gates {
		if !g.isOpen() {
			return false
		}
	}
	return true
}

// gated reports whether any gate is registered (used by tests that assert an
// ungated stage has no predicate installed).
func (f *fakeQueue) gated() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.gates) > 0
}

// emit pushes a name-tagged status snapshot to all subscribers, mirroring the
// real queue's emit so tests can drive the SSE event path. Non-blocking.
func (f *fakeQueue) emit() {
	f.mu.Lock()
	subs := append([]chan queue.Event(nil), f.subscribers...)
	ev := queue.Event{
		Name:   f.name,
		Status: queue.Status{Active: f.active, Pending: f.pending, MaxConcurrency: f.maxConc, IsPaused: f.paused},
	}
	f.mu.Unlock()
	for _, ch := range subs {
		select {
		case ch <- ev:
		default:
		}
	}
}

// --- Queue interface ---

func (f *fakeQueue) Enqueue(task queue.Task) {
	f.mu.Lock()
	f.enqueued = append(f.enqueued, task)
	f.mu.Unlock()
}

func (f *fakeQueue) GetStatus() queue.Status {
	f.mu.Lock()
	defer f.mu.Unlock()
	return queue.Status{Active: f.active, Pending: f.pending, MaxConcurrency: f.maxConc, IsPaused: f.paused}
}

func (f *fakeQueue) QueueSizes() (int, int, int) { return 0, f.pending, 0 }
func (f *fakeQueue) GetErrors() []queue.Error    { return nil }
func (f *fakeQueue) SetConcurrency(n int)        { f.mu.Lock(); f.maxConc = n; f.mu.Unlock() }
func (f *fakeQueue) Pause()                      { f.mu.Lock(); f.paused = true; f.mu.Unlock() }
func (f *fakeQueue) Resume()                     { f.mu.Lock(); f.paused = false; f.mu.Unlock() }
func (f *fakeQueue) Stop()                       { f.mu.Lock(); f.stopped = true; f.mu.Unlock() }

func (f *fakeQueue) RegisterGate(name string, isOpen func() bool) {
	f.mu.Lock()
	f.gates = append(f.gates, fakeGate{name: name, isOpen: isOpen})
	f.mu.Unlock()
}

func (f *fakeQueue) ClearGates() {
	f.mu.Lock()
	f.gates = nil
	f.mu.Unlock()
}

func (f *fakeQueue) Subscribe() <-chan queue.Event {
	ch := make(chan queue.Event, 16)
	f.mu.Lock()
	f.subscribers = append(f.subscribers, ch)
	f.mu.Unlock()
	return ch
}

func (f *fakeQueue) Kick() { f.mu.Lock(); f.kicks++; f.mu.Unlock() }

func (f *fakeQueue) kickCount() int { f.mu.Lock(); defer f.mu.Unlock(); return f.kicks }
