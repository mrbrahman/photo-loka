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

// TestCanDispatchGatesDispatch: a false CanDispatch keeps tasks pending and
// unstarted; flipping it true + Kick dispatches them.
func TestCanDispatchGatesDispatch(t *testing.T) {
	q := New(1)
	defer q.Stop()

	var gateOpen atomic.Bool // starts closed
	q.SetCanDispatch(func() bool { return gateOpen.Load() })

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

	// Open the gate and kick: the task should now run.
	gateOpen.Store(true)
	q.Kick()
	waitFor(t, "task to run after gate opens", func() bool { return ran.Load() == 1 })
}

// TestOnDrainedFiresOnceWhenEmptied: onDrained fires when a running task
// completes and leaves the queue empty (running+pending == 0), and does not
// fire while a task is still in flight.
func TestOnDrainedFiresOnBusyToDrainedOnly(t *testing.T) {
	q := New(1)
	defer q.Stop()

	var drained atomic.Int32
	q.SetOnDrained(func() { drained.Add(1) })

	started := make(chan struct{})
	release := make(chan struct{})
	q.Enqueue(blockingTask(started, release))

	<-started // task running
	// While the task runs, the queue is busy: onDrained must not have fired.
	time.Sleep(20 * time.Millisecond)
	if drained.Load() != 0 {
		t.Fatalf("onDrained fired while a task was running (count=%d)", drained.Load())
	}

	// Complete the task -> queue empties -> exactly one drained signal.
	release <- struct{}{}
	waitFor(t, "onDrained to fire", func() bool { return drained.Load() == 1 })

	time.Sleep(20 * time.Millisecond)
	if got := drained.Load(); got != 1 {
		t.Fatalf("onDrained fired %d times, want exactly 1", got)
	}
}

// TestOnDrainedNotFiredWhileWorkRemains: with a genuinely pending task (enqueued
// but the queue paused so it is not dequeued), completing an earlier task does
// not drain. This exercises the "running+pending > 0 blocks drain" rule without
// hitting the dequeued-but-blocked accounting window (a task dequeued and parked
// on the semaphore is intentionally not counted; that transient is benign for
// gating since it only triggers an extra re-check kick).
func TestOnDrainedNotFiredWhileWorkRemains(t *testing.T) {
	q := New(1)
	defer q.Stop()

	var drained atomic.Int32
	q.SetOnDrained(func() { drained.Add(1) })

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
	if drained.Load() != 0 {
		t.Fatalf("onDrained fired while task2 pending (count=%d)", drained.Load())
	}
	if task2Ran.Load() != 0 {
		t.Fatalf("task2 ran while paused")
	}

	// Resume: task2 runs, then the queue drains -> exactly one signal.
	q.Resume()
	waitFor(t, "task2 to run", func() bool { return task2Ran.Load() == 1 })
	waitFor(t, "onDrained after task2", func() bool { return drained.Load() == 1 })
}

// TestTwoQueueGate wires B gated behind A (B.CanDispatch = !A.busy) and A's
// drain kicks B. B must not start while A has running-or-pending work, and must
// start once A is fully drained.
func TestTwoQueueGate(t *testing.T) {
	a := New(1)
	b := New(1)
	defer a.Stop()
	defer b.Stop()

	aBusy := func() bool {
		st := a.GetStatus()
		return st.Active > 0 || st.Pending > 0
	}
	b.SetCanDispatch(func() bool { return !aBusy() })
	a.SetOnDrained(func() { b.Kick() })

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

	// Drain A. Its onDrained kicks B, whose gate is now open.
	aRelease <- struct{}{}
	waitFor(t, "B to run after A drains", func() bool { return bRan.Load() == 1 })
}

// TestGateOneDirectionalInFlightNotKilled: once B starts (A empty), new work
// arriving on A does not kill B's in-flight task; but no NEW B task starts
// until A drains again.
func TestGateOneDirectionalInFlightNotKilled(t *testing.T) {
	a := New(1)
	b := New(1)
	defer a.Stop()
	defer b.Stop()

	aBusy := func() bool {
		st := a.GetStatus()
		return st.Active > 0 || st.Pending > 0
	}
	b.SetCanDispatch(func() bool { return !aBusy() })
	a.SetOnDrained(func() { b.Kick() })

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
	q := New(1) // single worker so completion order == dispatch order
	defer q.Stop()

	// Gate closed initially so we can stage all three before any runs, making
	// the ordering deterministic regardless of enqueue timing.
	var open atomic.Bool
	q.SetCanDispatch(func() bool { return open.Load() })

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
