package geo

import (
	"encoding/json"
	"os"
	"sync"
	"time"

	"photo-loka/internal/config"
)

// Rate limiting for geonames API calls is package-level (single instance).
// Limits are read from the config.Runtime singleton at check time; the counters and
// their state file are package vars, initialized by initRateLimiter (called
// from Init).
var (
	rlMu          sync.Mutex
	rlHourlyCount int
	rlDailyCount  int
	rlCurrentHour int
	rlCurrentDay  int
	rlStateFile   string
)

// rateLimiterState is the serialized state written to disk.
type rateLimiterState struct {
	HourlyCount int `json:"hourly_count"`
	DailyCount  int `json:"daily_count"`
	CurrentHour int `json:"current_hour"`
	CurrentDay  int `json:"current_day"`
}

// initRateLimiter sets the state file and restores counters from disk if the
// saved hour/day still match the current time.
func initRateLimiter(stateFile string) {
	now := time.Now()
	rlStateFile = stateFile
	rlCurrentHour = now.Hour()
	rlCurrentDay = now.YearDay()

	if stateFile == "" {
		return
	}
	data, err := os.ReadFile(stateFile)
	if err != nil {
		return
	}
	var state rateLimiterState
	if json.Unmarshal(data, &state) != nil {
		return
	}
	// Only restore if same hour/day
	if state.CurrentHour == now.Hour() && state.CurrentDay == now.YearDay() {
		rlHourlyCount = state.HourlyCount
		rlDailyCount = state.DailyCount
	} else if state.CurrentDay == now.YearDay() {
		// Same day but different hour - keep daily count only
		rlDailyCount = state.DailyCount
	}
}

// rateCheck reports whether another geonames request is currently within
// budget. It is READ-ONLY: it does not reset counters and does not increment.
// Used as the API queues' "rate" gate predicate (isOpen), which the dispatch
// loop may call at any time, so it must have no side effects. Counter resets
// are owned by the rollover timer (see resetCounters); increments are owned by
// rateReserve.
func rateCheck() bool {
	rlMu.Lock()
	defer rlMu.Unlock()
	return rlHourlyCount < config.Runtime.GeonamesHourlyLimit && rlDailyCount < config.Runtime.GeonamesDailyLimit
}

// rateReserve atomically reserves one request against the budget: under a
// single lock it checks headroom AND, if available, increments both counters,
// returning true. If over budget it returns false and increments nothing. This
// check-and-increment must be atomic because two separate API queues (address
// and city) share this limiter at concurrency 1 each: a plain rateCheck then a
// later rateIncrement would let both queues slip through on the last unit and
// exceed geonames' hard limit. An API task calls rateReserve immediately before
// its HTTP call; the "rate" gate (rateCheck) only keeps work from dispatching
// while already over budget, so under normal flow the reserve succeeds.
func rateReserve() bool {
	rlMu.Lock()
	defer rlMu.Unlock()
	if rlHourlyCount >= config.Runtime.GeonamesHourlyLimit || rlDailyCount >= config.Runtime.GeonamesDailyLimit {
		return false
	}
	rlHourlyCount++
	rlDailyCount++
	return true
}

// resetCounters zeroes the hourly counter when the hour has rolled over and the
// daily counter when the day has rolled over, updating the tracked hour/day.
// Called by the rollover timer (geo.Init) just after each boundary; the timer
// then kicks the API queues so items held by the "rate" gate resume.
func resetCounters() {
	rlMu.Lock()
	defer rlMu.Unlock()
	now := time.Now()
	if now.Hour() != rlCurrentHour {
		rlHourlyCount = 0
		rlCurrentHour = now.Hour()
	}
	if now.YearDay() != rlCurrentDay {
		rlDailyCount = 0
		rlCurrentDay = now.YearDay()
	}
}

// SaveRateLimiter writes the current rate limiter state to the state file.
// Called on shutdown so counters survive a restart.
func SaveRateLimiter() {
	rlMu.Lock()
	state := rateLimiterState{
		HourlyCount: rlHourlyCount,
		DailyCount:  rlDailyCount,
		CurrentHour: rlCurrentHour,
		CurrentDay:  rlCurrentDay,
	}
	rlMu.Unlock()

	if rlStateFile == "" {
		return
	}

	data, err := json.Marshal(state)
	if err != nil {
		return
	}
	_ = os.WriteFile(rlStateFile, data, 0644)
}
