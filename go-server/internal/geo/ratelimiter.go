package geo

import (
	"encoding/json"
	"os"
	"sync"
	"time"

	"photo-loka/internal/config"
)

// Rate limiting for geonames API calls is package-level (single instance).
// Limits are read from the config.Rt singleton at check time; the counters and
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

// rateCheck returns true if another geonames request is allowed. It resets the
// counters when the hour or day changes.
func rateCheck() bool {
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

	return rlHourlyCount < config.Rt.GeonamesHourlyLimit && rlDailyCount < config.Rt.GeonamesDailyLimit
}

// rateIncrement increases both hourly and daily counters by one.
func rateIncrement() {
	rlMu.Lock()
	defer rlMu.Unlock()

	rlHourlyCount++
	rlDailyCount++
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
