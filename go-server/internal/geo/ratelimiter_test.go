package geo

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"photo-loka/internal/config"
)

// withLimits sets config.Runtime limits for a test and resets the package rate
// counters to a known zero state, restoring config.Runtime on cleanup.
func withLimits(t *testing.T, hourly, daily int) {
	t.Helper()
	prev := config.Runtime
	config.Runtime = &config.RuntimeConfig{
		GeonamesHourlyLimit: hourly,
		GeonamesDailyLimit:  daily,
	}
	rlMu.Lock()
	rlHourlyCount, rlDailyCount = 0, 0
	rlCurrentHour, rlCurrentDay = time.Now().Hour(), time.Now().YearDay()
	rlMu.Unlock()
	t.Cleanup(func() { config.Runtime = prev })
}

// TestRateReserve_StopsAtLimit: rateReserve grants exactly up to the smaller of
// the hourly/daily budgets, then denies.
func TestRateReserve_StopsAtLimit(t *testing.T) {
	withLimits(t, 3, 100) // hourly is the binding limit

	for i := 0; i < 3; i++ {
		if !rateReserve() {
			t.Fatalf("reserve %d should succeed (within budget 3)", i+1)
		}
	}
	if rateReserve() {
		t.Fatal("reserve 4 should be denied (over hourly budget 3)")
	}
	// rateCheck is read-only and should now report over budget without changing
	// counters.
	if rateCheck() {
		t.Fatal("rateCheck should report over budget after the limit is reached")
	}
}

// TestRateReserve_Atomic: under concurrent callers (the two API queues racing on
// the last unit), rateReserve grants no more than the budget. This is the
// property that keeps address+city queues from both slipping through on the
// final unit and exceeding geonames' hard limit.
func TestRateReserve_Atomic(t *testing.T) {
	const budget = 50
	withLimits(t, budget, 10000)

	var granted atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 200; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if rateReserve() {
				granted.Add(1)
			}
		}()
	}
	wg.Wait()

	if got := granted.Load(); got != budget {
		t.Fatalf("concurrent reserves granted = %d, want exactly %d (atomic check+increment)", got, budget)
	}
}

// TestResetCounters_HourRollover: resetCounters zeroes the hourly counter when
// the tracked hour differs from now, re-opening budget.
func TestResetCounters_HourRollover(t *testing.T) {
	withLimits(t, 2, 100)

	// Exhaust the hourly budget.
	rateReserve()
	rateReserve()
	if rateCheck() {
		t.Fatal("precondition: should be over budget after 2 reserves")
	}

	// Simulate the clock having advanced past the hour boundary by setting the
	// tracked hour to something that cannot equal the current hour.
	rlMu.Lock()
	rlCurrentHour = (time.Now().Hour() + 1) % 24
	rlMu.Unlock()

	resetCounters()

	if !rateCheck() {
		t.Fatal("rateCheck should report within budget after an hourly rollover reset")
	}
}
