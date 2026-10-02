package pipeline

import (
	"sync"
	"sync/atomic"
	"testing"

	"photo-loka/internal/config"
)

// withLimits sets config.Runtime geonames limits for a test, restoring the
// previous value on cleanup.
func withLimits(t *testing.T, hourly, daily int) {
	t.Helper()
	prev := config.Runtime
	config.Runtime = &config.RuntimeConfig{
		GeonamesHourlyLimit: hourly,
		GeonamesDailyLimit:  daily,
	}
	t.Cleanup(func() { config.Runtime = prev })
}

// newTestGeoRate builds a geo-rate gater with a temp (per-test) state file and
// zeroed counters.
func newTestGeoRate(t *testing.T, hourly, daily int) *geoRateGater {
	t.Helper()
	withLimits(t, hourly, daily)
	// Empty dataDir -> empty stateFile path -> persistence is a no-op, so the
	// test neither reads nor writes disk. restore() still sets current hour/day.
	g := newGeoRateGater([]string{StageGeoAddr, StageGeoCity}, "")
	return g
}

// TestGeoRate_IsOpenPureAndReserveConsumes: IsOpen is a read-only check (never
// consumes); Reserve consumes exactly up to the budget then denies.
func TestGeoRate_IsOpenPureAndReserveConsumes(t *testing.T) {
	g := newTestGeoRate(t, 3, 100)

	// IsOpen is pure: calling it many times does not consume budget.
	for i := 0; i < 10; i++ {
		if !g.IsOpen(StageGeoAddr) {
			t.Fatalf("IsOpen should stay open while no units reserved (iter %d)", i)
		}
	}
	// Reserve up to the hourly budget (3), then it denies.
	for i := 0; i < 3; i++ {
		if !g.Reserve() {
			t.Fatalf("reserve %d should succeed within budget 3", i+1)
		}
	}
	if g.Reserve() {
		t.Fatal("reserve 4 should be denied (over hourly budget 3)")
	}
	// Gate now reads closed.
	if g.IsOpen(StageGeoCity) {
		t.Fatal("IsOpen should report closed after the budget is exhausted")
	}
}

// TestGeoRate_ReserveAtomic: concurrent reserves (the two API queues racing on
// the last unit) grant no more than the budget.
func TestGeoRate_ReserveAtomic(t *testing.T) {
	const budget = 50
	g := newTestGeoRate(t, budget, 10000)

	var granted atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 200; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if g.Reserve() {
				granted.Add(1)
			}
		}()
	}
	wg.Wait()

	if got := granted.Load(); got != budget {
		t.Fatalf("concurrent reserves granted = %d, want exactly %d (atomic check+increment)", got, budget)
	}
}

// TestGeoRate_RolloverReopens: an hourly rollover reset re-opens the budget.
func TestGeoRate_RolloverReopens(t *testing.T) {
	g := newTestGeoRate(t, 2, 100)

	g.Reserve()
	g.Reserve()
	if g.IsOpen(StageGeoAddr) {
		t.Fatal("precondition: over budget after 2 reserves")
	}

	// Simulate the hour having advanced so resetRollover zeroes the hourly count.
	g.mu.Lock()
	g.currentHour = (g.currentHour + 1) % 24
	g.mu.Unlock()
	g.resetRollover()

	if !g.IsOpen(StageGeoAddr) {
		t.Fatal("IsOpen should reopen after an hourly rollover reset")
	}
}
