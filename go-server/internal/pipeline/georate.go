package pipeline

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"photo-loka/internal/config"
)

// geoRateGater implements Gater for geonames rate limiting. It is fully
// self-contained and symmetric with resourceGater: it owns its condition (the
// geonames request budget: hourly/daily counters + their persisted state file),
// decides WHEN to kick its queues (an hour/day rollover timer), and WHAT to
// kick (the two governed geo API queues). The geo package knows nothing about
// rate limiting -- it only performs cache lookups and geonames calls; the API
// stage functions call Reserve on this gater just before each geonames request.
//
// Gate vs reserve: IsOpen is a pure, read-only budget check the queue may
// evaluate repeatedly per dispatch attempt (and on attempts that then bail at
// the concurrency-slot or stop checks). Reserve is the atomic check-and-
// increment that actually consumes one unit, called exactly once per real API
// call from the geo-lookup-addr / geo-lookup-city stage functions. Keeping the
// consume out of IsOpen avoids over-counting across those speculative
// evaluations; making it atomic stops the two API queues (concurrency 1 each,
// sharing this budget) from both slipping through on the last unit and
// exceeding geonames' hard limit.
type geoRateGater struct {
	governs   []string
	stateFile string

	mu           sync.Mutex
	hourlyCount  int
	dailyCount   int
	currentHour  int
	currentDay   int

	stop chan struct{}
	wg   sync.WaitGroup

	// kick is set in Attach: kicks the governed queues (so items held by the
	// closed "rate" gate resume after a rollover reset).
	kick func()
}

// newGeoRateGater builds the gater governing the given queues, restoring the
// persisted counters from the state file under dataDir (same file the geo
// package used before: rate_limit_state.json).
func newGeoRateGater(governs []string, dataDir string) *geoRateGater {
	stateFile := ""
	if dataDir != "" {
		stateFile = filepath.Join(dataDir, "rate_limit_state.json")
	}
	g := &geoRateGater{
		governs:   governs,
		stateFile: stateFile,
	}
	g.restore()
	return g
}

func grLogger() *slog.Logger { return slog.Default().With("component", "geo-rate-gater") }

func (g *geoRateGater) GateName() string  { return "rate" }
func (g *geoRateGater) Governs() []string { return g.governs }

// IsOpen is the read-only budget check (the "rate" gate predicate). Same for
// every governed queue (the two API queues share one budget), so queueName is
// ignored.
func (g *geoRateGater) IsOpen(string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.underBudgetLocked()
}

func (g *geoRateGater) underBudgetLocked() bool {
	if config.Runtime == nil {
		// No runtime config loaded yet: do not gate (open). Normal operation
		// always has config.Runtime; this guards tests and early startup.
		return true
	}
	return g.hourlyCount < config.Runtime.GeonamesHourlyLimit &&
		g.dailyCount < config.Runtime.GeonamesDailyLimit
}

// Reserve atomically consumes one request unit: under one lock it checks
// headroom and, if available, increments both counters and returns true (then
// persists). Returns false if over budget (consuming nothing) -- the caller
// skips the call and the item waits for the next rollover kick. Called once per
// real geonames request by the API stage functions.
func (g *geoRateGater) Reserve() bool {
	g.mu.Lock()
	if !g.underBudgetLocked() {
		g.mu.Unlock()
		return false
	}
	g.hourlyCount++
	g.dailyCount++
	state := g.snapshotLocked()
	g.mu.Unlock()
	g.persist(state)
	return true
}

// Attach registers the "rate" gate on each governed queue and starts the
// rollover timer. Idempotent: tears down a previous timer generation first,
// clears + re-registers the gate, captures fresh queue kick handles. The gate
// has no drained-subscription (its condition changes on the timer, not on
// upstream drains).
func (g *geoRateGater) Attach(host gateHost) {
	// Tear down previous timer generation.
	if g.stop != nil {
		close(g.stop)
		g.wg.Wait()
	}
	g.stop = make(chan struct{})
	stop := g.stop

	governs := g.governs
	g.kick = func() {
		for _, name := range governs {
			if q := host.queueByName(name); q != nil {
				q.Kick()
			}
		}
	}
	for _, name := range governs {
		if q := host.queueByName(name); q != nil {
			q.ClearGate("rate")
			q.RegisterGate("rate", func() bool { return g.IsOpen(name) })
		}
	}

	g.wg.Add(1)
	go g.runTimer(stop)
}

// runTimer resets the rolled-over counters just after each hour boundary and
// kicks the governed queues so items held by the closed gate resume. A single
// hourly tick covers both resets (resetRollover zeroes the daily counter only
// when the day also rolled over). The +30s buffer mirrors the Node.js reference
// so we are safely into the new hour/day.
func (g *geoRateGater) runTimer(stop chan struct{}) {
	defer g.wg.Done()
	for {
		now := time.Now()
		nextHour := now.Truncate(time.Hour).Add(time.Hour)
		wait := time.Until(nextHour) + 30*time.Second
		select {
		case <-stop:
			return
		case <-time.After(wait):
		}
		g.resetRollover()
		if g.kick != nil {
			g.kick()
		}
		grLogger().Debug("geonames rate counters rolled over; kicked API queues")
	}
}

// resetRollover zeroes the hourly counter when the hour changed and the daily
// counter when the day changed, then persists.
func (g *geoRateGater) resetRollover() {
	g.mu.Lock()
	now := time.Now()
	if now.Hour() != g.currentHour {
		g.hourlyCount = 0
		g.currentHour = now.Hour()
	}
	if now.YearDay() != g.currentDay {
		g.dailyCount = 0
		g.currentDay = now.YearDay()
	}
	state := g.snapshotLocked()
	g.mu.Unlock()
	g.persist(state)
}

// Stop tears down the rollover timer and persists the final counters.
func (g *geoRateGater) Stop() {
	g.mu.Lock()
	if g.stop != nil {
		close(g.stop)
		g.stop = nil
	}
	state := g.snapshotLocked()
	g.mu.Unlock()
	g.wg.Wait()
	g.persist(state)
}

// rateState is the serialized counter state (same shape/file as the former
// geo.rateLimiterState, so existing state files are read transparently).
type rateState struct {
	HourlyCount int `json:"hourly_count"`
	DailyCount  int `json:"daily_count"`
	CurrentHour int `json:"current_hour"`
	CurrentDay  int `json:"current_day"`
}

func (g *geoRateGater) snapshotLocked() rateState {
	return rateState{
		HourlyCount: g.hourlyCount,
		DailyCount:  g.dailyCount,
		CurrentHour: g.currentHour,
		CurrentDay:  g.currentDay,
	}
}

// restore loads counters from the state file, keeping them only if the saved
// hour/day still match now (same rule the geo package used).
func (g *geoRateGater) restore() {
	now := time.Now()
	g.currentHour = now.Hour()
	g.currentDay = now.YearDay()
	if g.stateFile == "" {
		return
	}
	data, err := os.ReadFile(g.stateFile)
	if err != nil {
		return
	}
	var s rateState
	if json.Unmarshal(data, &s) != nil {
		return
	}
	if s.CurrentHour == now.Hour() && s.CurrentDay == now.YearDay() {
		g.hourlyCount = s.HourlyCount
		g.dailyCount = s.DailyCount
	} else if s.CurrentDay == now.YearDay() {
		g.dailyCount = s.DailyCount
	}
}

func (g *geoRateGater) persist(s rateState) {
	if g.stateFile == "" {
		return
	}
	data, err := json.Marshal(s)
	if err != nil {
		return
	}
	_ = os.WriteFile(g.stateFile, data, 0644)
}

var _ Gater = (*geoRateGater)(nil)
