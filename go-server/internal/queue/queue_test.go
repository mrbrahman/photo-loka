package queue

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// waitFor polls cond until it holds or the deadline elapses, failing the test
// otherwise. Used instead of fixed sleeps so tests are deterministic on the
// happy path and bounded on failure.
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

// blockingTask returns a task that signals on started when it begins and blocks
// until release is closed. Lets a test hold a task "running" deterministically.
func blockingTask(started chan<- struct{}, release <-chan struct{}) Task {
	return Task{
		Description: "blocking",
		Fn: func() error {
			started <- struct{}{}
			<-release
			return nil
		},
	}
}

// TestGateBlocksDispatch: a closed gate keeps tasks pending and unstarted;
// opening it + Kick dispatches them. (Replaces the old SetCanDispatch test.)
func TestGateBlocksDispatch(t *testing.T) {
	q := New("test", 1)
	defer q.Stop()

	var gateOpen atomic.Bool // starts closed
	q.RegisterGate("test", func() bool { return gateOpen.Load() })

	var ran atomic.Int32
	q.Enqueue(Task{Description: "gated", Fn: func() error {
		ran.Add(1)
		return nil
	}})

	// While the gate is closed, the task must stay pending and never run.
	waitFor(t, "task to be pending", func() bool { return q.GetStatus().Pending == 1 })
	time.Sleep(20 * time.Millisecond)
	if ran.Load() != 0 {
		t.Fatalf("task ran while gate closed")
	}
	if got := q.GetStatus().Active; got != 0 {
		t.Fatalf("active = %d while gate closed, want 0", got)
	}
	// The block reason reflects the closed gate's name while work is pending.
	if got := q.GetStatus().BlockReason; got != "test" {
		t.Fatalf("block reason = %q while gate closed, want %q", got, "test")
	}

	// Open the gate and kick: the task should now run.
	gateOpen.Store(true)
	q.Kick()
	waitFor(t, "task to run after gate opens", func() bool { return ran.Load() == 1 })
	// Once dispatched, the block reason clears.
	waitFor(t, "block reason to clear", func() bool { return q.GetStatus().BlockReason == "" })
}

// drainedCounter subscribes to a queue and counts busy->drained transitions
// seen on the event stream: an event whose snapshot has Active==0 && Pending==0
// that follows a non-drained state. This is the event-stream equivalent of the
// old onDrained callback (which fired exactly on that transition). Used so the
// migrated tests assert the same guarantee the callback provided.
type drainedCounter struct {
	count atomic.Int32
}

func watchDrained(q *Queue) *drainedCounter {
	dc := &drainedCounter{}
	ch := q.Subscribe()
	go func() {
		wasDrained := true // an empty queue starts drained; first real work un-drains it
		for ev := range ch {
			nowDrained := ev.Status.Active == 0 && ev.Status.Pending == 0
			if nowDrained && !wasDrained {
				dc.count.Add(1)
			}
			wasDrained = nowDrained
		}
	}()
	return dc
}

func (dc *drainedCounter) val() int32 { return dc.count.Load() }

// TestDrainedEventOnBusyToDrainedOnly: a drained transition appears on the event
// stream when a running task completes and leaves the queue empty, and not while
// a task is still in flight. (Replaces the old SetOnDrained test.)
func TestDrainedEventOnBusyToDrainedOnly(t *testing.T) {
	q := New("test", 1)
	defer q.Stop()

	dc := watchDrained(q)

	started := make(chan struct{})
	release := make(chan struct{})
	q.Enqueue(blockingTask(started, release))

	<-started // task running
	// While the task runs, the queue is busy: no drained transition yet.
	time.Sleep(20 * time.Millisecond)
	if dc.val() != 0 {
		t.Fatalf("drained transition seen while a task was running (count=%d)", dc.val())
	}

	// Complete the task -> queue empties -> exactly one drained transition.
	release <- struct{}{}
	waitFor(t, "drained transition to appear", func() bool { return dc.val() == 1 })

	time.Sleep(20 * time.Millisecond)
	if got := dc.val(); got != 1 {
		t.Fatalf("drained transition seen %d times, want exactly 1", got)
	}
}

// TestDrainedNotSeenWhileWorkRemains: with a genuinely pending task (enqueued
// but the queue paused so it is not dequeued), completing an earlier task does
// not produce a drained transition (pending > 0).
func TestDrainedNotSeenWhileWorkRemains(t *testing.T) {
	q := New("test", 1)
	defer q.Stop()

	dc := watchDrained(q)

	started := make(chan struct{})
	release := make(chan struct{})
	q.Enqueue(blockingTask(started, release))
	<-started // task1 running

	// Enqueue task2 but immediately pause so it stays genuinely pending (never
	// dequeued) while task1 finishes.
	q.Pause()
	var task2Ran atomic.Int32
	q.Enqueue(Task{Description: "t2", Fn: func() error { task2Ran.Add(1); return nil }})
	waitFor(t, "task2 pending", func() bool { return q.GetStatus().Pending == 1 })

	// Finish task1. running->0 but pending==1 -> NOT drained.
	release <- struct{}{}
	time.Sleep(30 * time.Millisecond)
	if dc.val() != 0 {
		t.Fatalf("drained transition seen while task2 pending (count=%d)", dc.val())
	}
	if task2Ran.Load() != 0 {
		t.Fatalf("task2 ran while paused")
	}

	// Resume: task2 runs, then the queue drains -> exactly one transition.
	q.Resume()
	waitFor(t, "task2 to run", func() bool { return task2Ran.Load() == 1 })
	waitFor(t, "drained after task2", func() bool { return dc.val() == 1 })
}

// gateBehind wires queue b to be gated behind queue a: b registers a "resource"
// gate that is open only when a is fully drained, and a subscriber kicks b on
// a's busy->drained transition. This mirrors how the pipeline orchestrator wires
// a gated stage behind its upstream using the new RegisterGate + event-stream
// API (replacing the old SetCanDispatch/SetOnDrained pair).
func gateBehind(b, a *Queue) {
	aBusy := func() bool {
		st := a.GetStatus()
		return st.Active > 0 || st.Pending > 0
	}
	b.RegisterGate("resource", func() bool { return !aBusy() })
	ch := a.Subscribe()
	go func() {
		wasDrained := true
		for ev := range ch {
			nowDrained := ev.Status.Active == 0 && ev.Status.Pending == 0
			if nowDrained && !wasDrained {
				b.Kick()
			}
			wasDrained = nowDrained
		}
	}()
}

// TestTwoQueueGate wires B gated behind A and A's drain kicks B. B must not
// start while A has running-or-pending work, and must start once A is fully
// drained.
func TestTwoQueueGate(t *testing.T) {
	a := New("a", 1)
	b := New("b", 1)
	defer a.Stop()
	defer b.Stop()

	gateBehind(b, a)

	aStarted := make(chan struct{})
	aRelease := make(chan struct{})
	a.Enqueue(blockingTask(aStarted, aRelease))

	var bRan atomic.Int32
	b.Enqueue(Task{Description: "b", Fn: func() error { bRan.Add(1); return nil }})

	<-aStarted // A is running
	// B is gated closed: it must not run while A is busy.
	time.Sleep(20 * time.Millisecond)
	if bRan.Load() != 0 {
		t.Fatalf("B ran while A busy")
	}
	waitFor(t, "B pending", func() bool { return b.GetStatus().Pending == 1 })

	// Drain A. Its drained event kicks B, whose gate is now open.
	aRelease <- struct{}{}
	waitFor(t, "B to run after A drains", func() bool { return bRan.Load() == 1 })
}

// TestGateOneDirectionalInFlightNotKilled: once B starts (A empty), new work
// arriving on A does not kill B's in-flight task; but no NEW B task starts
// until A drains again.
func TestGateOneDirectionalInFlightNotKilled(t *testing.T) {
	a := New("a", 1)
	b := New("b", 1)
	defer a.Stop()
	defer b.Stop()

	gateBehind(b, a)

	// A is empty, so B may start. Start a blocking B task.
	bStarted := make(chan struct{})
	bRelease := make(chan struct{})
	b.Enqueue(blockingTask(bStarted, bRelease))
	<-bStarted // B1 is running

	// New work arrives on A while B1 is in flight.
	aStarted := make(chan struct{})
	aRelease := make(chan struct{})
	a.Enqueue(blockingTask(aStarted, aRelease))
	<-aStarted

	// Enqueue a second B task: it must NOT start while A is busy.
	var b2Ran atomic.Int32
	b.Enqueue(Task{Description: "b2", Fn: func() error { b2Ran.Add(1); return nil }})
	time.Sleep(20 * time.Millisecond)
	if b2Ran.Load() != 0 {
		t.Fatalf("B2 started while A busy")
	}

	// B1 (in flight) is allowed to finish; it was never killed.
	bRelease <- struct{}{}
	waitFor(t, "A still busy, B2 still gated", func() bool { return b.GetStatus().Pending == 1 })
	if b2Ran.Load() != 0 {
		t.Fatalf("B2 started while A still busy")
	}

	// Drain A -> B2 may now run.
	aRelease <- struct{}{}
	waitFor(t, "B2 to run after A drains", func() bool { return b2Ran.Load() == 1 })
}

// TestPriorityOrderWithGate is a regression check that adding the gate predicate
// did not break priority ordering: High runs before Normal before Low.
func TestPriorityOrderWithGate(t *testing.T) {
	q := New("test", 1) // single worker so completion order == dispatch order
	defer q.Stop()

	// Gate closed initially so we can stage all three before any runs, making
	// the ordering deterministic regardless of enqueue timing.
	var open atomic.Bool
	q.RegisterGate("test", func() bool { return open.Load() })

	var mu sync.Mutex
	var order []string
	record := func(name string) Task {
		return Task{Description: name, Fn: func() error {
			mu.Lock()
			order = append(order, name)
			mu.Unlock()
			return nil
		}}
	}

	q.Enqueue(Task{Priority: Low, Description: "low", Fn: record("low").Fn})
	q.Enqueue(Task{Priority: Normal, Description: "normal", Fn: record("normal").Fn})
	q.Enqueue(Task{Priority: High, Description: "high", Fn: record("high").Fn})

	waitFor(t, "all three pending", func() bool { return q.GetStatus().Pending == 3 })

	open.Store(true)
	q.Kick()

	waitFor(t, "all three to run", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(order) == 3
	})

	mu.Lock()
	defer mu.Unlock()
	want := []string{"high", "normal", "low"}
	for i := range want {
		if order[i] != want[i] {
			t.Fatalf("dispatch order = %v, want %v", order, want)
		}
	}
}

// peakTracker records the maximum observed concurrent executions.
type peakTracker struct {
	mu   sync.Mutex
	cur  int
	peak int
}

func (p *peakTracker) enter() {
	p.mu.Lock()
	p.cur++
	if p.cur > p.peak {
		p.peak = p.cur
	}
	p.mu.Unlock()
}

func (p *peakTracker) leave() {
	p.mu.Lock()
	p.cur--
	p.mu.Unlock()
}

func (p *peakTracker) peakVal() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.peak
}

// TestConcurrencyCapUnderPauseResume hammers pause/resume while many tasks are
// queued at concurrency 1, and asserts the queue never runs more than one task
// at a time. This reproduces the bug where a task dequeued and parked on a full
// (blocking) semaphore would start through a pause, letting >maxConcurrency
// tasks run after a rapid play/pause.
func TestConcurrencyCapUnderPauseResume(t *testing.T) {
	q := New("test", 1)
	defer q.Stop()

	var pk peakTracker
	var done atomic.Int32
	const total = 40

	for i := 0; i < total; i++ {
		q.Enqueue(Task{Description: "t", Fn: func() error {
			pk.enter()
			// Small busy window so overlaps, if any, are observable.
			time.Sleep(time.Millisecond)
			pk.leave()
			done.Add(1)
			return nil
		}})
	}

	// Rapidly toggle pause/resume while the queue works through the backlog.
	toggleDone := make(chan struct{})
	go func() {
		for i := 0; i < 200; i++ {
			q.Pause()
			time.Sleep(200 * time.Microsecond)
			q.Resume()
			time.Sleep(200 * time.Microsecond)
		}
		close(toggleDone)
	}()

	<-toggleDone
	// Ensure it is resumed so the backlog can finish.
	q.Resume()
	waitFor(t, "all tasks to finish", func() bool { return int(done.Load()) == total })

	if got := pk.peakVal(); got > 1 {
		t.Fatalf("peak concurrency = %d, want <= 1 (concurrency cap violated under pause/resume)", got)
	}
}

// TestNoStartThroughPause targets the specific race deterministically: with a
// task running (at capacity 1) and a second task pending, pausing must prevent
// the pending task from starting even after the running one completes; only
// after resume may it run.
func TestNoStartThroughPause(t *testing.T) {
	q := New("test", 1)
	defer q.Stop()

	started := make(chan struct{})
	release := make(chan struct{})
	q.Enqueue(blockingTask(started, release)) // task A

	var bRan atomic.Int32
	q.Enqueue(Task{Description: "B", Fn: func() error { bRan.Add(1); return nil }}) // task B pending

	<-started // A running, at capacity; B pending (or parked)

	// Pause while A is in flight and B is waiting.
	q.Pause()

	// Let A complete. Under the bug, B (parked on the semaphore) would start
	// despite the pause. It must not.
	release <- struct{}{}
	time.Sleep(50 * time.Millisecond)
	if bRan.Load() != 0 {
		t.Fatalf("task B started while paused (started through pause)")
	}

	// Resume -> B may now run.
	q.Resume()
	waitFor(t, "B to run after resume", func() bool { return bRan.Load() == 1 })
}
