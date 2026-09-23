package frames

import (
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"photo-loka/internal/scheduler"
	"photo-loka/internal/search"
)

// ErrFramePaused is returned when a frame is paused and cannot advance.
var ErrFramePaused = errors.New("Frame is paused")

// PauseState represents the automatic pause state of a frame.
type PauseState struct {
	Paused       bool    `json:"paused"`
	PauseEndTime *string `json:"pauseEndTime"`
}

// ManualPauseState represents a user-initiated pause on a frame.
type ManualPauseState struct {
	Paused           bool  `json:"paused"`
	ResumeAtSchedule *bool `json:"resumeAtSchedule"`
}

// FrameState holds the in-memory runtime state for a single frame.
type FrameState struct {
	Items       []interface{}
	CurrIdx     int
	AutoPause   PauseState
	ManualPause ManualPauseState
}

// Frame management is package-level (single instance): in-memory frame states,
// SSE clients, and cron scheduling. The two maps have separate guards.
var (
	framesMu    sync.RWMutex
	frameStates = make(map[string]*FrameState) // ip -> state
	sseClients  = make(map[string]chan string) // ip -> SSE channel
	sseMu       sync.Mutex
	frLogger    = slog.Default().With("component", "frame-manager")
)

// LoadAllFrames loads all frames from DB and initializes in-memory state.
// Cron jobs are scheduled separately via ScheduleAllFrameJobs.
func LoadAllFrames() error {
	dbFrames, err := GetAll()
	if err != nil {
		return fmt.Errorf("loading frames from DB: %w", err)
	}

	for i := range dbFrames {
		frame := &dbFrames[i]

		// Initialize in-memory state
		framesMu.Lock()
		frameStates[frame.FrameIPAddr] = &FrameState{
			Items:   make([]interface{}, 0),
			CurrIdx: -1,
		}
		framesMu.Unlock()

		// Load items for this frame
		if err := ReloadItemsForFrame(frame); err != nil {
			frLogger.Warn("failed to load items for frame",
				"frame_id", frame.FrameID,
				"ip", frame.FrameIPAddr,
				"error", err,
			)
		}

		// Note: cron jobs are scheduled separately via ScheduleAllFrameJobs
		// so that state-loading and job-scheduling are distinct concerns.

		// Check if currently in pause window
		if frame.DailyPauseRange != nil && *frame.DailyPauseRange != "" {
			if isInPauseWindow(*frame.DailyPauseRange) {
				framesMu.Lock()
				if state, ok := frameStates[frame.FrameIPAddr]; ok {
					state.AutoPause.Paused = true
				}
				framesMu.Unlock()
			}
		}
	}

	frLogger.Info("all frames loaded", "count", len(dbFrames))
	return nil
}

// GetAllFrames returns all DB frames merged with their in-memory state.
func GetAllFrames() ([]map[string]interface{}, error) {
	dbFrames, err := GetAll()
	if err != nil {
		return nil, fmt.Errorf("getting frames: %w", err)
	}

	framesMu.RLock()
	defer framesMu.RUnlock()

	results := make([]map[string]interface{}, 0, len(dbFrames))
	for _, frame := range dbFrames {
		item := map[string]interface{}{
			"frame_id":          frame.FrameID,
			"frame_ip_addr":     frame.FrameIPAddr,
			"frame_name":        frame.FrameName,
			"collection_id":     frame.CollectionID,
			"search_str":        frame.SearchStr,
			"display_order":     frame.DisplayOrder,
			"daily_pause_range": frame.DailyPauseRange,
			"reset_schedule":    frame.ResetSchedule,
		}

		if state, ok := frameStates[frame.FrameIPAddr]; ok {
			item["numItems"] = len(state.Items)
			item["currIdx"] = state.CurrIdx
			item["autoPause"] = state.AutoPause
			item["manualPause"] = state.ManualPause
		}

		results = append(results, item)
	}

	return results, nil
}

// CreateFrame inserts a frame into the DB, initializes in-memory state, and schedules jobs.
func CreateFrame(frame *Frame) (int64, error) {
	id, err := Create(frame)
	if err != nil {
		return 0, err
	}
	frame.FrameID = id

	// Initialize in-memory state
	framesMu.Lock()
	frameStates[frame.FrameIPAddr] = &FrameState{
		Items:   make([]interface{}, 0),
		CurrIdx: -1,
	}
	framesMu.Unlock()

	// Load items
	if err := ReloadItemsForFrame(frame); err != nil {
		frLogger.Warn("failed to load items for new frame",
			"frame_id", id,
			"error", err,
		)
	}

	// Schedule jobs
	scheduleJobsForFrame(frame)

	return id, nil
}

// UpdateFrame updates the DB record, refreshes in-memory state, and reschedules jobs.
func UpdateFrame(frameID int64, frame *Frame) error {
	// Get old frame to know the old IP
	oldFrame, err := GetByID(frameID)
	if err != nil {
		return err
	}
	if oldFrame == nil {
		return fmt.Errorf("frame %d not found", frameID)
	}

	if err := Update(frameID, frame); err != nil {
		return err
	}

	// Remove old state if IP changed
	framesMu.Lock()
	if oldFrame.FrameIPAddr != frame.FrameIPAddr {
		delete(frameStates, oldFrame.FrameIPAddr)
	}
	frameStates[frame.FrameIPAddr] = &FrameState{
		Items:   make([]interface{}, 0),
		CurrIdx: -1,
	}
	framesMu.Unlock()

	// Remove old jobs and schedule new ones
	removeJobsForFrame(oldFrame.FrameID)

	frame.FrameID = frameID
	scheduleJobsForFrame(frame)

	// Reload items
	if err := ReloadItemsForFrame(frame); err != nil {
		frLogger.Warn("failed to reload items after update",
			"frame_id", frameID,
			"error", err,
		)
	}

	return nil
}

// DeleteFrame removes the frame from DB, in-memory state, and cron jobs.
func DeleteFrame(frameID int64) error {
	frame, err := GetByID(frameID)
	if err != nil {
		return err
	}
	if frame == nil {
		return fmt.Errorf("frame %d not found", frameID)
	}

	if err := Delete(frameID); err != nil {
		return err
	}

	framesMu.Lock()
	delete(frameStates, frame.FrameIPAddr)
	framesMu.Unlock()

	removeJobsForFrame(frameID)

	return nil
}

// PauseFrame manually pauses a frame. If resumeAtSchedule is set, it will
// auto-resume at the next scheduled unpause time.
func PauseFrame(frameID int64, resumeAtSchedule *bool) error {
	frame, err := GetByID(frameID)
	if err != nil {
		return err
	}
	if frame == nil {
		return fmt.Errorf("frame %d not found", frameID)
	}

	framesMu.Lock()
	state, ok := frameStates[frame.FrameIPAddr]
	if !ok {
		framesMu.Unlock()
		return fmt.Errorf("frame state not found for IP %s", frame.FrameIPAddr)
	}
	state.ManualPause.Paused = true
	state.ManualPause.ResumeAtSchedule = resumeAtSchedule
	framesMu.Unlock()

	notifySSE(frame.FrameIPAddr, "pause")
	frLogger.Info("frame paused manually", "frame_id", frameID, "ip", frame.FrameIPAddr, "resume_at_schedule", resumeAtSchedule)
	return nil
}

// ResumeFrame manually resumes a paused frame.
func ResumeFrame(frameID int64) error {
	frame, err := GetByID(frameID)
	if err != nil {
		return err
	}
	if frame == nil {
		return fmt.Errorf("frame %d not found", frameID)
	}

	framesMu.Lock()
	state, ok := frameStates[frame.FrameIPAddr]
	if !ok {
		framesMu.Unlock()
		return fmt.Errorf("frame state not found for IP %s", frame.FrameIPAddr)
	}
	state.ManualPause.Paused = false
	state.ManualPause.ResumeAtSchedule = nil
	framesMu.Unlock()

	notifySSE(frame.FrameIPAddr, "resume")
	frLogger.Info("frame resumed", "frame_id", frameID, "ip", frame.FrameIPAddr)
	return nil
}

// GetNextItem returns the next item for the frame at the given IP, advancing the index.
func GetNextItem(ip string) (interface{}, error) {
	framesMu.Lock()
	state, ok := frameStates[ip]
	if !ok {
		framesMu.Unlock()
		return nil, fmt.Errorf("no frame registered for IP %s", ip)
	}

	// Check if paused (either auto or manual)
	if state.AutoPause.Paused || state.ManualPause.Paused {
		framesMu.Unlock()
		return nil, ErrFramePaused
	}

	if len(state.Items) == 0 {
		framesMu.Unlock()
		return nil, nil
	}

	// Advance index (wrap around)
	state.CurrIdx = (state.CurrIdx + 1) % len(state.Items)
	item := state.Items[state.CurrIdx]
	framesMu.Unlock()

	return item, nil
}

// GetPrevItem returns the previous item for the frame at the given IP, decrementing the index.
func GetPrevItem(ip string) (interface{}, error) {
	framesMu.Lock()
	state, ok := frameStates[ip]
	if !ok {
		framesMu.Unlock()
		return nil, fmt.Errorf("no frame registered for IP %s", ip)
	}

	// Check if paused
	if state.AutoPause.Paused || state.ManualPause.Paused {
		framesMu.Unlock()
		return nil, ErrFramePaused
	}

	if len(state.Items) == 0 {
		framesMu.Unlock()
		return nil, nil
	}

	// Decrement index (wrap around)
	state.CurrIdx--
	if state.CurrIdx < 0 {
		state.CurrIdx = len(state.Items) - 1
	}
	item := state.Items[state.CurrIdx]
	framesMu.Unlock()

	return item, nil
}

// SetAutoPause sets the automatic pause state for a frame.
func SetAutoPause(frameID int64, paused bool) error {
	frame, err := GetByID(frameID)
	if err != nil {
		return err
	}
	if frame == nil {
		return fmt.Errorf("frame %d not found", frameID)
	}

	framesMu.Lock()
	state, ok := frameStates[frame.FrameIPAddr]
	if !ok {
		framesMu.Unlock()
		return fmt.Errorf("frame state not found for IP %s", frame.FrameIPAddr)
	}
	state.AutoPause.Paused = paused
	if !paused {
		state.AutoPause.PauseEndTime = nil
		// If auto-resuming and currently manually paused with resumeAtSchedule, clear the manual pause
		if state.ManualPause.Paused && state.ManualPause.ResumeAtSchedule != nil && *state.ManualPause.ResumeAtSchedule {
			state.ManualPause.Paused = false
			state.ManualPause.ResumeAtSchedule = nil
		}
	}
	// Determine if frame is still paused after state changes
	stillPaused := state.AutoPause.Paused || state.ManualPause.Paused
	framesMu.Unlock()

	if paused {
		notifySSE(frame.FrameIPAddr, "pause")
	} else if !stillPaused {
		// Only send resume if the frame is truly unpaused (not still manually paused)
		notifySSE(frame.FrameIPAddr, "resume")
	}

	return nil
}

// ReloadItemsForFrame runs the frame's search query and updates the in-memory items list.
func ReloadItemsForFrame(frame *Frame) error {
	if frame.SearchStr == "" {
		return nil
	}

	// Run search: not trashed, flat (not grouped), with display_order
	displayOrder := ""
	if frame.DisplayOrder != nil {
		displayOrder = *frame.DisplayOrder
	}

	results, err := search.RunSearch(frame.CollectionID, frame.SearchStr, false, false, displayOrder, nil)
	if err != nil {
		return fmt.Errorf("running search for frame %d: %w", frame.FrameID, err)
	}

	// Convert flat results to generic items
	var items []interface{}
	if flatResults, ok := results.([]search.FlatResult); ok {
		for _, r := range flatResults {
			items = append(items, r)
		}
	}

	if items == nil {
		items = make([]interface{}, 0)
	}

	framesMu.Lock()
	if state, ok := frameStates[frame.FrameIPAddr]; ok {
		state.Items = items
		state.CurrIdx = -1
	}
	framesMu.Unlock()

	frLogger.Info("items loaded for frame",
		"frame_id", frame.FrameID,
		"ip", frame.FrameIPAddr,
		"count", len(items),
	)

	notifySSE(frame.FrameIPAddr, "reload")
	return nil
}

// RegisterSSEClient creates and returns an SSE channel for the given IP.
func RegisterSSEClient(ip string) chan string {
	sseMu.Lock()
	defer sseMu.Unlock()

	ch := make(chan string, 10)
	sseClients[ip] = ch
	frLogger.Info("SSE client connected", "ip", ip)
	return ch
}

// UnregisterSSEClient removes the SSE channel for the given IP.
func UnregisterSSEClient(ip string) {
	sseMu.Lock()
	defer sseMu.Unlock()

	if ch, ok := sseClients[ip]; ok {
		close(ch)
		delete(sseClients, ip)
	}
	frLogger.Info("SSE client disconnected", "ip", ip)
}

// AllFrameIPs returns the set of all registered frame IPs (for auth bypass).
func AllFrameIPs() map[string]struct{} {
	framesMu.RLock()
	defer framesMu.RUnlock()

	ips := make(map[string]struct{}, len(frameStates))
	for ip := range frameStates {
		ips[ip] = struct{}{}
	}
	return ips
}

// notifySSE sends an event to the SSE channel for the given IP, if connected.
func notifySSE(ip, eventType string) {
	sseMu.Lock()
	defer sseMu.Unlock()

	if ch, ok := sseClients[ip]; ok {
		select {
		case ch <- eventType:
			frLogger.Info("sent SSE event to frame", "ip", ip, "event", eventType)
		default:
			// Channel full, skip notification
		}
	} else {
		frLogger.Warn("no SSE client found for frame", "ip", ip, "event", eventType)
	}
}

// scheduleJobsForFrame schedules reset and pause/resume cron jobs for a frame.
func scheduleJobsForFrame(frame *Frame) {
	// Schedule playlist reset job
	if frame.ResetSchedule != nil && *frame.ResetSchedule != "" {
		jobName := fmt.Sprintf("frame_%d_reset", frame.FrameID)
		f := frame
		err := scheduler.AddJob(jobName, *frame.ResetSchedule, func() {
			if err := ReloadItemsForFrame(f); err != nil {
				frLogger.Error("frame playlist reset failed",
					"frame_id", f.FrameID,
					"error", err,
				)
			}
		})
		if err != nil {
			frLogger.Error("failed to schedule frame reset job",
				"frame_id", frame.FrameID,
				"pattern", *frame.ResetSchedule,
				"error", err,
			)
		} else {
			frLogger.Info("scheduled frame reset job", "frame_id", frame.FrameID, "schedule", *frame.ResetSchedule)
		}
	}

	// Schedule daily pause/resume if configured
	if frame.DailyPauseRange != nil && *frame.DailyPauseRange != "" {
		parts := strings.Split(*frame.DailyPauseRange, "-")
		if len(parts) == 2 {
			startTime := strings.TrimSpace(parts[0])
			endTime := strings.TrimSpace(parts[1])

			startParts := strings.Split(startTime, ":")
			endParts := strings.Split(endTime, ":")

			if len(startParts) == 2 && len(endParts) == 2 {
				// Schedule pause job: at start time every day
				pauseJobName := fmt.Sprintf("frame_%d_pause", frame.FrameID)
				pausePattern := fmt.Sprintf("%s %s * * *", startParts[1], startParts[0])
				frameID := frame.FrameID
				err := scheduler.AddJob(pauseJobName, pausePattern, func() {
					if err := SetAutoPause(frameID, true); err != nil {
						frLogger.Error("auto-pause failed", "frame_id", frameID, "error", err)
					}
				})
				if err != nil {
					frLogger.Error("failed to schedule frame pause job",
						"frame_id", frame.FrameID,
						"error", err,
					)
				} else {
					frLogger.Info("scheduled frame pause job", "frame_id", frame.FrameID, "schedule", pausePattern)
				}

				// Schedule resume job: at end time every day
				resumeJobName := fmt.Sprintf("frame_%d_resume", frame.FrameID)
				resumePattern := fmt.Sprintf("%s %s * * *", endParts[1], endParts[0])
				err = scheduler.AddJob(resumeJobName, resumePattern, func() {
					if err := SetAutoPause(frameID, false); err != nil {
						frLogger.Error("auto-resume failed", "frame_id", frameID, "error", err)
					}
				})
				if err != nil {
					frLogger.Error("failed to schedule frame resume job",
						"frame_id", frame.FrameID,
						"error", err,
					)
				} else {
					frLogger.Info("scheduled frame resume job", "frame_id", frame.FrameID, "schedule", resumePattern)
				}
			}
		}
	}
}

// removeJobsForFrame removes all cron jobs associated with a frame.
func removeJobsForFrame(frameID int64) {
	scheduler.DeleteJob(fmt.Sprintf("frame_%d_reset", frameID))
	scheduler.DeleteJob(fmt.Sprintf("frame_%d_pause", frameID))
	scheduler.DeleteJob(fmt.Sprintf("frame_%d_resume", frameID))
}

// isInPauseWindow checks if the current time falls within the HH:mm-HH:mm pause range.
func isInPauseWindow(dailyPauseRange string) bool {
	parts := strings.Split(dailyPauseRange, "-")
	if len(parts) != 2 {
		return false
	}

	now := time.Now()
	currentMinutes := now.Hour()*60 + now.Minute()

	startTime := strings.TrimSpace(parts[0])
	endTime := strings.TrimSpace(parts[1])

	startParts := strings.Split(startTime, ":")
	endParts := strings.Split(endTime, ":")

	if len(startParts) != 2 || len(endParts) != 2 {
		return false
	}

	startH, startM := parseTimeComponent(startParts[0]), parseTimeComponent(startParts[1])
	endH, endM := parseTimeComponent(endParts[0]), parseTimeComponent(endParts[1])

	startMinutes := startH*60 + startM
	endMinutes := endH*60 + endM

	if startMinutes <= endMinutes {
		// Normal range (e.g. 22:00-06:00 does NOT apply here; 08:00-17:00 does)
		return currentMinutes >= startMinutes && currentMinutes < endMinutes
	}
	// Overnight range (e.g. 22:00-06:00)
	return currentMinutes >= startMinutes || currentMinutes < endMinutes
}

// parseTimeComponent parses a time string component (hour or minute) to int.
func parseTimeComponent(s string) int {
	val := 0
	for _, c := range s {
		if c >= '0' && c <= '9' {
			val = val*10 + int(c-'0')
		}
	}
	return val
}

// ScheduleAllFrameJobs schedules cron jobs (reset, pause/resume) for all loaded frames.
func ScheduleAllFrameJobs() {
	framesMu.RLock()
	defer framesMu.RUnlock()

	frames, err := GetAll()
	if err != nil {
		frLogger.Error("failed to get frames for job scheduling", "error", err)
		return
	}

	for i := range frames {
		scheduleJobsForFrame(&frames[i])
	}
	frLogger.Info("frame jobs scheduled", "count", len(frames))
}
