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

// Manager manages in-memory frame states, SSE clients, and cron scheduling.
type Manager struct {
	mu         sync.RWMutex
	frames     map[string]*FrameState // ip -> state
	db         *FramesDB
	searchDB   *search.SearchDB
	scheduler  *scheduler.Scheduler
	sseClients map[string]chan string // ip -> SSE channel
	sseMu      sync.Mutex
	logger     *slog.Logger
}

// NewManager creates a new frame Manager.
func NewManager(db *FramesDB, searchDB *search.SearchDB, sched *scheduler.Scheduler) *Manager {
	return &Manager{
		frames:     make(map[string]*FrameState),
		db:         db,
		searchDB:   searchDB,
		scheduler:  sched,
		sseClients: make(map[string]chan string),
		logger:     slog.Default().With("component", "frame-manager"),
	}
}

// LoadAllFrames loads all frames from DB, initializes in-memory state, and schedules jobs.
func (m *Manager) LoadAllFrames() error {
	dbFrames, err := m.db.GetAll()
	if err != nil {
		return fmt.Errorf("loading frames from DB: %w", err)
	}

	for i := range dbFrames {
		frame := &dbFrames[i]

		// Initialize in-memory state
		m.mu.Lock()
		m.frames[frame.FrameIPAddr] = &FrameState{
			Items:   make([]interface{}, 0),
			CurrIdx: -1,
		}
		m.mu.Unlock()

		// Load items for this frame
		if err := m.ReloadItemsForFrame(frame); err != nil {
			m.logger.Warn("failed to load items for frame",
				"frame_id", frame.FrameID,
				"ip", frame.FrameIPAddr,
				"error", err,
			)
		}

		// Schedule cron jobs
		m.scheduleJobsForFrame(frame)

		// Check if currently in pause window
		if frame.DailyPauseRange != nil && *frame.DailyPauseRange != "" {
			if isInPauseWindow(*frame.DailyPauseRange) {
				m.mu.Lock()
				if state, ok := m.frames[frame.FrameIPAddr]; ok {
					state.AutoPause.Paused = true
				}
				m.mu.Unlock()
			}
		}
	}

	m.logger.Info("all frames loaded", "count", len(dbFrames))
	return nil
}

// GetAllFrames returns all DB frames merged with their in-memory state.
func (m *Manager) GetAllFrames() ([]map[string]interface{}, error) {
	dbFrames, err := m.db.GetAll()
	if err != nil {
		return nil, fmt.Errorf("getting frames: %w", err)
	}

	m.mu.RLock()
	defer m.mu.RUnlock()

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

		if state, ok := m.frames[frame.FrameIPAddr]; ok {
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
func (m *Manager) CreateFrame(frame *Frame) (int64, error) {
	id, err := m.db.Create(frame)
	if err != nil {
		return 0, err
	}
	frame.FrameID = id

	// Initialize in-memory state
	m.mu.Lock()
	m.frames[frame.FrameIPAddr] = &FrameState{
		Items:   make([]interface{}, 0),
		CurrIdx: -1,
	}
	m.mu.Unlock()

	// Load items
	if err := m.ReloadItemsForFrame(frame); err != nil {
		m.logger.Warn("failed to load items for new frame",
			"frame_id", id,
			"error", err,
		)
	}

	// Schedule jobs
	m.scheduleJobsForFrame(frame)

	return id, nil
}

// UpdateFrame updates the DB record, refreshes in-memory state, and reschedules jobs.
func (m *Manager) UpdateFrame(frameID int64, frame *Frame) error {
	// Get old frame to know the old IP
	oldFrame, err := m.db.GetByID(frameID)
	if err != nil {
		return err
	}
	if oldFrame == nil {
		return fmt.Errorf("frame %d not found", frameID)
	}

	if err := m.db.Update(frameID, frame); err != nil {
		return err
	}

	// Remove old state if IP changed
	m.mu.Lock()
	if oldFrame.FrameIPAddr != frame.FrameIPAddr {
		delete(m.frames, oldFrame.FrameIPAddr)
	}
	m.frames[frame.FrameIPAddr] = &FrameState{
		Items:   make([]interface{}, 0),
		CurrIdx: -1,
	}
	m.mu.Unlock()

	// Remove old jobs and schedule new ones
	m.removeJobsForFrame(oldFrame.FrameID)

	frame.FrameID = frameID
	m.scheduleJobsForFrame(frame)

	// Reload items
	if err := m.ReloadItemsForFrame(frame); err != nil {
		m.logger.Warn("failed to reload items after update",
			"frame_id", frameID,
			"error", err,
		)
	}

	return nil
}

// DeleteFrame removes the frame from DB, in-memory state, and cron jobs.
func (m *Manager) DeleteFrame(frameID int64) error {
	frame, err := m.db.GetByID(frameID)
	if err != nil {
		return err
	}
	if frame == nil {
		return fmt.Errorf("frame %d not found", frameID)
	}

	if err := m.db.Delete(frameID); err != nil {
		return err
	}

	m.mu.Lock()
	delete(m.frames, frame.FrameIPAddr)
	m.mu.Unlock()

	m.removeJobsForFrame(frameID)

	return nil
}

// PauseFrame manually pauses a frame. If resumeAtSchedule is set, it will
// auto-resume at the next scheduled unpause time.
func (m *Manager) PauseFrame(frameID int64, resumeAtSchedule *bool) error {
	frame, err := m.db.GetByID(frameID)
	if err != nil {
		return err
	}
	if frame == nil {
		return fmt.Errorf("frame %d not found", frameID)
	}

	m.mu.Lock()
	state, ok := m.frames[frame.FrameIPAddr]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("frame state not found for IP %s", frame.FrameIPAddr)
	}
	state.ManualPause.Paused = true
	state.ManualPause.ResumeAtSchedule = resumeAtSchedule
	m.mu.Unlock()

	m.notifySSE(frame.FrameIPAddr, "pause")
	return nil
}

// ResumeFrame manually resumes a paused frame.
func (m *Manager) ResumeFrame(frameID int64) error {
	frame, err := m.db.GetByID(frameID)
	if err != nil {
		return err
	}
	if frame == nil {
		return fmt.Errorf("frame %d not found", frameID)
	}

	m.mu.Lock()
	state, ok := m.frames[frame.FrameIPAddr]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("frame state not found for IP %s", frame.FrameIPAddr)
	}
	state.ManualPause.Paused = false
	state.ManualPause.ResumeAtSchedule = nil
	m.mu.Unlock()

	m.notifySSE(frame.FrameIPAddr, "resume")
	return nil
}

// GetNextItem returns the next item for the frame at the given IP, advancing the index.
func (m *Manager) GetNextItem(ip string) (interface{}, error) {
	m.mu.Lock()
	state, ok := m.frames[ip]
	if !ok {
		m.mu.Unlock()
		return nil, fmt.Errorf("no frame registered for IP %s", ip)
	}

	// Check if paused (either auto or manual)
	if state.AutoPause.Paused || state.ManualPause.Paused {
		m.mu.Unlock()
		return nil, ErrFramePaused
	}

	if len(state.Items) == 0 {
		m.mu.Unlock()
		return nil, nil
	}

	// Advance index (wrap around)
	state.CurrIdx = (state.CurrIdx + 1) % len(state.Items)
	item := state.Items[state.CurrIdx]
	m.mu.Unlock()

	return item, nil
}

// GetPrevItem returns the previous item for the frame at the given IP, decrementing the index.
func (m *Manager) GetPrevItem(ip string) (interface{}, error) {
	m.mu.Lock()
	state, ok := m.frames[ip]
	if !ok {
		m.mu.Unlock()
		return nil, fmt.Errorf("no frame registered for IP %s", ip)
	}

	// Check if paused
	if state.AutoPause.Paused || state.ManualPause.Paused {
		m.mu.Unlock()
		return nil, ErrFramePaused
	}

	if len(state.Items) == 0 {
		m.mu.Unlock()
		return nil, nil
	}

	// Decrement index (wrap around)
	state.CurrIdx--
	if state.CurrIdx < 0 {
		state.CurrIdx = len(state.Items) - 1
	}
	item := state.Items[state.CurrIdx]
	m.mu.Unlock()

	return item, nil
}

// SetAutoPause sets the automatic pause state for a frame.
func (m *Manager) SetAutoPause(frameID int64, paused bool) error {
	frame, err := m.db.GetByID(frameID)
	if err != nil {
		return err
	}
	if frame == nil {
		return fmt.Errorf("frame %d not found", frameID)
	}

	m.mu.Lock()
	state, ok := m.frames[frame.FrameIPAddr]
	if !ok {
		m.mu.Unlock()
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
	m.mu.Unlock()

	if paused {
		m.notifySSE(frame.FrameIPAddr, "pause")
	} else if !stillPaused {
		// Only send resume if the frame is truly unpaused (not still manually paused)
		m.notifySSE(frame.FrameIPAddr, "resume")
	}

	return nil
}

// ReloadItemsForFrame runs the frame's search query and updates the in-memory items list.
func (m *Manager) ReloadItemsForFrame(frame *Frame) error {
	if frame.SearchStr == "" {
		return nil
	}

	// Run search: not trashed, flat (not grouped), with display_order
	displayOrder := ""
	if frame.DisplayOrder != nil {
		displayOrder = *frame.DisplayOrder
	}

	results, err := m.searchDB.RunSearch(frame.CollectionID, frame.SearchStr, false, false, displayOrder, nil)
	if err != nil {
		return fmt.Errorf("running search for frame %d: %w", frame.FrameID, err)
	}

	// Convert flat results to generic items
	var items []interface{}
	if flatResults, ok := results.([]search.FlatResult); ok {
		for _, r := range flatResults {
			items = append(items, r.Item)
		}
	}

	if items == nil {
		items = make([]interface{}, 0)
	}

	m.mu.Lock()
	if state, ok := m.frames[frame.FrameIPAddr]; ok {
		state.Items = items
		state.CurrIdx = 0
	}
	m.mu.Unlock()

	m.logger.Debug("items reloaded for frame",
		"frame_id", frame.FrameID,
		"ip", frame.FrameIPAddr,
		"count", len(items),
	)

	m.notifySSE(frame.FrameIPAddr, "reload")
	return nil
}

// RegisterSSEClient creates and returns an SSE channel for the given IP.
func (m *Manager) RegisterSSEClient(ip string) chan string {
	m.sseMu.Lock()
	defer m.sseMu.Unlock()

	ch := make(chan string, 10)
	m.sseClients[ip] = ch
	return ch
}

// UnregisterSSEClient removes the SSE channel for the given IP.
func (m *Manager) UnregisterSSEClient(ip string) {
	m.sseMu.Lock()
	defer m.sseMu.Unlock()

	if ch, ok := m.sseClients[ip]; ok {
		close(ch)
		delete(m.sseClients, ip)
	}
}

// AllFrameIPs returns the set of all registered frame IPs (for auth bypass).
func (m *Manager) AllFrameIPs() map[string]struct{} {
	m.mu.RLock()
	defer m.mu.RUnlock()

	ips := make(map[string]struct{}, len(m.frames))
	for ip := range m.frames {
		ips[ip] = struct{}{}
	}
	return ips
}

// notifySSE sends an event to the SSE channel for the given IP, if connected.
func (m *Manager) notifySSE(ip, eventType string) {
	m.sseMu.Lock()
	defer m.sseMu.Unlock()

	if ch, ok := m.sseClients[ip]; ok {
		select {
		case ch <- eventType:
		default:
			// Channel full, skip notification
		}
	}
}

// scheduleJobsForFrame schedules reset and pause/resume cron jobs for a frame.
func (m *Manager) scheduleJobsForFrame(frame *Frame) {
	// Schedule playlist reset job
	if frame.ResetSchedule != nil && *frame.ResetSchedule != "" {
		jobName := fmt.Sprintf("frame_%d_reset", frame.FrameID)
		f := frame
		err := m.scheduler.AddJob(jobName, *frame.ResetSchedule, func() {
			if err := m.ReloadItemsForFrame(f); err != nil {
				m.logger.Error("frame playlist reset failed",
					"frame_id", f.FrameID,
					"error", err,
				)
			}
		})
		if err != nil {
			m.logger.Error("failed to schedule frame reset job",
				"frame_id", frame.FrameID,
				"pattern", *frame.ResetSchedule,
				"error", err,
			)
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
				err := m.scheduler.AddJob(pauseJobName, pausePattern, func() {
					if err := m.SetAutoPause(frameID, true); err != nil {
						m.logger.Error("auto-pause failed", "frame_id", frameID, "error", err)
					}
				})
				if err != nil {
					m.logger.Error("failed to schedule frame pause job",
						"frame_id", frame.FrameID,
						"error", err,
					)
				}

				// Schedule resume job: at end time every day
				resumeJobName := fmt.Sprintf("frame_%d_resume", frame.FrameID)
				resumePattern := fmt.Sprintf("%s %s * * *", endParts[1], endParts[0])
				err = m.scheduler.AddJob(resumeJobName, resumePattern, func() {
					if err := m.SetAutoPause(frameID, false); err != nil {
						m.logger.Error("auto-resume failed", "frame_id", frameID, "error", err)
					}
				})
				if err != nil {
					m.logger.Error("failed to schedule frame resume job",
						"frame_id", frame.FrameID,
						"error", err,
					)
				}
			}
		}
	}
}

// removeJobsForFrame removes all cron jobs associated with a frame.
func (m *Manager) removeJobsForFrame(frameID int64) {
	m.scheduler.DeleteJob(fmt.Sprintf("frame_%d_reset", frameID))
	m.scheduler.DeleteJob(fmt.Sprintf("frame_%d_pause", frameID))
	m.scheduler.DeleteJob(fmt.Sprintf("frame_%d_resume", frameID))
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
func (m *Manager) ScheduleAllFrameJobs() {
	m.mu.RLock()
	defer m.mu.RUnlock()

	frames, err := m.db.GetAll()
	if err != nil {
		m.logger.Error("failed to get frames for job scheduling", "error", err)
		return
	}

	for i := range frames {
		m.scheduleJobsForFrame(&frames[i])
	}
	m.logger.Info("frame jobs scheduled", "count", len(frames))
}
