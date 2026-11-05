package pipeline

import (
	"sync"
	"testing"
	"time"

	"photo-loka/internal/queue"
)

// driver wraps a watcher with a step barrier so a test can apply inputs in a
// deterministic order despite the activity and event channels being merged by
// an unordered select in the run goroutine. Each input (entry or event) is
// followed by a blocking wait for the run goroutine to acknowledge it has been
// fully processed, so the next input observes the prior one's effect.
type driver struct {
	t     *testing.T
	w     *batchWatcher
	srcs  []chan queue.Event
	step  chan struct{}
	mu    sync.Mutex
	ended []BatchEnded
}

func newDriver(t *testing.T, nQueues int, quiet time.Duration) *driver {
	t.Helper()
	d := &driver{t: t, step: make(chan struct{}, 1)}

	srcs := make([]chan queue.Event, nQueues)
	roch := make([]<-chan queue.Event, nQueues)
	for i := range srcs {
		srcs[i] = make(chan queue.Event, 16)
		roch[i] = srcs[i]
	}
	d.srcs = srcs

	w := newBatchWatcher()
	w.quiet = quiet
	w.onStep = func() { d.step <- struct{}{} }
	w.setOnBatchEnded(func(b BatchEnded) {
		d.mu.Lock()
		d.ended = append(d.ended, b)
		d.mu.Unlock()
	})
	d.w = w

	w.start(roch)
	t.Cleanup(w.Stop)
	return d
}

// entry sends a submitEntry signal and waits for it to be processed.
func (d *driver) entry(collID int64) {
	d.t.Helper()
	d.w.noteEntry(collID)
	d.await()
}

// event sends a queue event on source i and waits for it to be processed.
func (d *driver) event(i int, ev queue.Event) {
	d.t.Helper()
	d.srcs[i] <- ev
	d.await()
}

// await blocks until the run goroutine acknowledges one processed input.
func (d *driver) await() {
	d.t.Helper()
	select {
	case <-d.step:
	case <-time.After(2 * time.Second):
		d.t.Fatal("timed out waiting for the watcher to process an input")
	}
}

func (d *driver) count() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.ended)
}

func (d *driver) batches() []BatchEnded {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make([]BatchEnded, len(d.ended))
	copy(out, d.ended)
	return out
}

// waitForCount polls until the collected batch count reaches n or the deadline.
func (d *driver) waitForCount(n int) {
	d.t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if d.count() >= n {
			return
		}
		time.Sleep(time.Millisecond)
	}
	d.t.Fatalf("timed out waiting for %d batches; got %d", n, d.count())
}

func busyEv(name string) queue.Event {
	return queue.Event{Name: name, Status: queue.Status{Active: 1}}
}
func idleEv(name string) queue.Event {
	return queue.Event{Name: name, Status: queue.Status{Active: 0, Pending: 0}}
}

// TestBatch_SingleRunFiresOnce: a new item opens a batch; one queue goes busy
// then idle; after the quiet period exactly one BatchEnded fires with the right
// collection id.
func TestBatch_SingleRunFiresOnce(t *testing.T) {
	d := newDriver(t, 1, 30*time.Millisecond)
	d.entry(42)
	d.event(0, busyEv("q"))
	d.event(0, idleEv("q"))

	d.waitForCount(1)
	got := d.batches()[0]
	if len(got.CollectionIDs) != 1 || got.CollectionIDs[0] != 42 {
		t.Fatalf("want collection [42], got %v", got.CollectionIDs)
	}
	if got.EndedAt.Before(got.StartedAt) {
		t.Fatalf("ended (%v) should be >= started (%v)", got.EndedAt, got.StartedAt)
	}
}

// TestBatch_InterStageDipDoesNotSplit: a brief all-idle dip shorter than the
// quiet period (one stage drains before the next dispatches) must NOT close the
// batch; the whole run reports as one batch.
func TestBatch_InterStageDipDoesNotSplit(t *testing.T) {
	d := newDriver(t, 1, 80*time.Millisecond)
	d.entry(1)
	d.event(0, busyEv("q")) // busy (stage A)
	d.event(0, idleEv("q")) // brief idle (A drained) -> arms close timer
	// Before the quiet period elapses, go busy again (stage B picked up).
	time.Sleep(30 * time.Millisecond)
	d.event(0, busyEv("q")) // cancels the pending close
	d.event(0, idleEv("q")) // finally idle -> re-arms close timer

	d.waitForCount(1)
	// Ensure no spurious second batch.
	time.Sleep(120 * time.Millisecond)
	if d.count() != 1 {
		t.Fatalf("inter-stage dip split the batch: want 1, got %d", d.count())
	}
}

// TestBatch_TwoRealBatches: two separate runs with a gap longer than the quiet
// period fire two BatchEnded signals.
func TestBatch_TwoRealBatches(t *testing.T) {
	d := newDriver(t, 1, 30*time.Millisecond)

	d.entry(1)
	d.event(0, busyEv("q"))
	d.event(0, idleEv("q"))
	d.waitForCount(1)

	d.entry(2)
	d.event(0, busyEv("q"))
	d.event(0, idleEv("q"))
	d.waitForCount(2)

	b := d.batches()
	if b[0].CollectionIDs[0] != 1 || b[1].CollectionIDs[0] != 2 {
		t.Fatalf("want batches for [1] then [2], got %v and %v",
			b[0].CollectionIDs, b[1].CollectionIDs)
	}
}

// TestBatch_NoEntryNoBatch: queue activity WITHOUT a submitEntry (e.g. a
// metadata refresh / standalone stage run) must not open or close a batch.
func TestBatch_NoEntryNoBatch(t *testing.T) {
	d := newDriver(t, 1, 30*time.Millisecond)
	d.event(0, busyEv("q"))
	d.event(0, idleEv("q"))

	time.Sleep(120 * time.Millisecond)
	if d.count() != 0 {
		t.Fatalf("activity without an entry opened a batch: got %d", d.count())
	}
}

// TestBatch_MultipleCollections: several entries across two collections during
// one batch yield a single BatchEnded carrying both collection ids (sorted),
// with duplicates collapsed.
func TestBatch_MultipleCollections(t *testing.T) {
	d := newDriver(t, 1, 30*time.Millisecond)
	d.entry(7)
	d.event(0, busyEv("q"))
	d.entry(3)
	d.entry(7) // duplicate collapses
	d.event(0, idleEv("q"))

	d.waitForCount(1)
	got := d.batches()[0].CollectionIDs
	if len(got) != 2 || got[0] != 3 || got[1] != 7 {
		t.Fatalf("want sorted [3 7], got %v", got)
	}
}

// TestBatch_AggregateAcrossQueues: two queues; the batch must not close until
// BOTH are idle (the aggregate is the OR of all queues).
func TestBatch_AggregateAcrossQueues(t *testing.T) {
	d := newDriver(t, 2, 40*time.Millisecond)
	d.entry(1)
	d.event(0, busyEv("a"))
	d.event(1, busyEv("b"))
	d.event(0, idleEv("a")) // a idle, b still busy -> must NOT arm/close

	time.Sleep(80 * time.Millisecond)
	if d.count() != 0 {
		t.Fatalf("closed while a queue was still busy")
	}

	d.event(1, idleEv("b")) // now both idle -> close after quiet period
	d.waitForCount(1)
}
