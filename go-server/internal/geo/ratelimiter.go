package geo

import (
	"encoding/json"
	"os"
	"sync"
	"time"
)

// RateLimiter enforces hourly and daily limits for geonames API calls.
type RateLimiter struct {
	mu          sync.Mutex
	hourlyCount int
	dailyCount  int
	currentHour int
	currentDay  int
	hourlyLimit int
	dailyLimit  int
	stateFile   string
}

// rateLimiterState is the serialized state written to disk.
type rateLimiterState struct {
	HourlyCount int `json:"hourly_count"`
	DailyCount  int `json:"daily_count"`
	CurrentHour int `json:"current_hour"`
	CurrentDay  int `json:"current_day"`
}

// NewRateLimiter creates a new RateLimiter with the given limits.
// If a state file exists and the saved hour/day match the current time,
// the counters are restored from disk.
func NewRateLimiter(hourlyLimit, dailyLimit int, stateFile string) *RateLimiter {
	now := time.Now()
	rl := &RateLimiter{
		hourlyLimit: hourlyLimit,
		dailyLimit:  dailyLimit,
		stateFile:   stateFile,
		currentHour: now.Hour(),
		currentDay:  now.YearDay(),
	}

	// Attempt to load saved state
	if stateFile != "" {
		data, err := os.ReadFile(stateFile)
		if err == nil {
			var state rateLimiterState
			if json.Unmarshal(data, &state) == nil {
				// Only restore if same hour/day
				if state.CurrentHour == now.Hour() && state.CurrentDay == now.YearDay() {
					rl.hourlyCount = state.HourlyCount
					rl.dailyCount = state.DailyCount
				} else if state.CurrentDay == now.YearDay() {
					// Same day but different hour - keep daily count only
					rl.dailyCount = state.DailyCount
				}
			}
		}
	}

	return rl
}

// Check returns true if the rate limiter allows another request.
// It resets counters when the hour or day changes.
func (r *RateLimiter) Check() bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	now := time.Now()

	// Reset hourly counter on hour change
	if now.Hour() != r.currentHour {
		r.hourlyCount = 0
		r.currentHour = now.Hour()
	}

	// Reset daily counter on day change
	if now.YearDay() != r.currentDay {
		r.dailyCount = 0
		r.currentDay = now.YearDay()
	}

	return r.hourlyCount < r.hourlyLimit && r.dailyCount < r.dailyLimit
}

// Increment increases both hourly and daily counters by one.
func (r *RateLimiter) Increment() {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.hourlyCount++
	r.dailyCount++
}

// Save writes the current rate limiter state to the state file.
func (r *RateLimiter) Save() {
	r.mu.Lock()
	state := rateLimiterState{
		HourlyCount: r.hourlyCount,
		DailyCount:  r.dailyCount,
		CurrentHour: r.currentHour,
		CurrentDay:  r.currentDay,
	}
	r.mu.Unlock()

	if r.stateFile == "" {
		return
	}

	data, err := json.Marshal(state)
	if err != nil {
		return
	}
	_ = os.WriteFile(r.stateFile, data, 0644)
}

// Status returns the current state of the rate limiter as a map.
func (r *RateLimiter) Status() map[string]interface{} {
	r.mu.Lock()
	defer r.mu.Unlock()

	return map[string]interface{}{
		"hourly_count": r.hourlyCount,
		"hourly_limit": r.hourlyLimit,
		"daily_count":  r.dailyCount,
		"daily_limit":  r.dailyLimit,
		"current_hour": r.currentHour,
		"current_day":  r.currentDay,
	}
}
