package pipeline

import (
	"sync"

	"photo-loka/internal/queue"
)

// fakeQueue is a test double for the pipeline's Queue interface. It runs no
// goroutines: the test sets the reported busy state (active/pending) directly
// and inspects the hooks the pipeline installs (canDispatch/onDrained) and the
// kicks/enqueues it makes. This lets orchestrator tests exercise gating logic
// deterministically, without the real queue's dispatch timing (which is covered
// by queue_test.go).
type fakeQueue struct {
	mu      sync.Mutex
	active  int
	pending int

	canDispatch func() bool
	onDrained   func()

	kicks    int
	enqueued []queue.Task
	paused   bool
	stopped  bool
	maxConc  int
}

func newFakeQueue() *fakeQueue { return &fakeQueue{maxConc: 1} }

// setBusy sets the reported running/pending counts (what upstreamBusy reads).
func (f *fakeQueue) setBusy(active, pending int) {
	f.mu.Lock()
	f.active, f.pending = active, pending
	f.mu.Unlock()
}

// fireDrained invokes the pipeline-installed onDrained hook, simulating this
// queue's busy->drained transition.
func (f *fakeQueue) fireDrained() {
	f.mu.Lock()
	fn := f.onDrained
	f.mu.Unlock()
	if fn != nil {
		fn()
	}
}

// dispatchAllowed evaluates the pipeline-installed CanDispatch predicate (the
// gate). Returns true if no predicate was installed (ungated).
func (f *fakeQueue) dispatchAllowed() bool {
	f.mu.Lock()
	fn := f.canDispatch
	f.mu.Unlock()
	return fn == nil || fn()
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

func (f *fakeQueue) SetCanDispatch(fn func() bool) { f.mu.Lock(); f.canDispatch = fn; f.mu.Unlock() }
func (f *fakeQueue) SetOnDrained(fn func())        { f.mu.Lock(); f.onDrained = fn; f.mu.Unlock() }
func (f *fakeQueue) Kick()                         { f.mu.Lock(); f.kicks++; f.mu.Unlock() }

func (f *fakeQueue) kickCount() int { f.mu.Lock(); defer f.mu.Unlock(); return f.kicks }
