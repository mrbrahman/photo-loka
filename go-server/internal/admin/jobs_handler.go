package admin

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"photo-loka/internal/collections"
	"photo-loka/internal/frames"
	"photo-loka/internal/jobs"
	"photo-loka/internal/scheduler"
)

// JobsHandler handles job monitoring and control endpoints.
type JobsHandler struct {
	scheduler         *scheduler.Scheduler
	fileWatcher       *jobs.FileWatcher
	scheduledIndexing *jobs.ScheduledIndexing
	colDB             *collections.CollectionsDB
	frameManager      *frames.Manager
}

// NewJobsHandler creates a new JobsHandler.
func NewJobsHandler(sched *scheduler.Scheduler, fw *jobs.FileWatcher, si *jobs.ScheduledIndexing, colDB *collections.CollectionsDB, fm *frames.Manager) *JobsHandler {
	return &JobsHandler{
		scheduler:         sched,
		fileWatcher:       fw,
		scheduledIndexing: si,
		colDB:             colDB,
		frameManager:      fm,
	}
}

// RegisterRoutes registers job management routes on the given router group.
func (h *JobsHandler) RegisterRoutes(rg *gin.RouterGroup) {
	rg.GET("/jobs", h.getJobs)
	rg.POST("/startAllWatchers", h.startAllWatchers)
	rg.POST("/stopAllWatchers", h.stopAllWatchers)
	rg.POST("/startScheduledIndexing", h.startScheduledIndexing)
	rg.POST("/stopScheduledIndexing", h.stopScheduledIndexing)
}

// watcherStatus describes an intake watcher and its current state.
type watcherStatus struct {
	CollectionID   int64  `json:"collection_id"`
	CollectionName string `json:"collection_name"`
	IntakePath     string `json:"intake_path"`
	IntakeIndex    int    `json:"intake_index"`
	Status         string `json:"status"` // "active" or "stopped"
}

// scheduledJobStatus describes a scheduled intake job and its current state.
type scheduledJobStatus struct {
	Name           string `json:"name"`
	CollectionID   int64  `json:"collection_id"`
	CollectionName string `json:"collection_name"`
	IntakePath     string `json:"intake_path"`
	IntakeIndex    int    `json:"intake_index"`
	Pattern        string `json:"pattern"`
	Status         string `json:"status"` // "active" or "stopped"
}

// cronJobInfo describes an active cron job entry.
type cronJobInfo struct {
	Name    string `json:"name"`
	Pattern string `json:"pattern"`
}

// jobsResponse is the structure returned by GET /jobs.
type jobsResponse struct {
	Watchers  []watcherStatus      `json:"watchers"`
	Scheduled []scheduledJobStatus `json:"scheduled"`
	Frame     []cronJobInfo        `json:"frame"`
	System    []cronJobInfo        `json:"system"`
}

// intakeConfigEntry represents a single intake config entry for parsing.
type intakeConfigEntry struct {
	Path   string          `json:"path"`
	Method string          `json:"method"`
	Config json.RawMessage `json:"config"`
}

// scheduledConfig holds the schedule field from an intake config entry.
type scheduledConfig struct {
	Schedule string `json:"schedule"`
}

// getJobs returns the current state of all jobs.
// GET /api/admin/jobs
func (h *JobsHandler) getJobs(c *gin.Context) {
	// Get all collections
	cols, err := h.colDB.GetAll()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{
				"message": err.Error(),
				"code":    "INTERNAL_ERROR",
			},
		})
		return
	}

	// Build a map of active watchers for quick lookup
	activeWatchers := h.fileWatcher.ListAll()
	activeWatcherPaths := make(map[string]bool)
	for _, w := range activeWatchers {
		key := fmt.Sprintf("%d:%s", w.CollectionID, w.IntakePath)
		activeWatcherPaths[key] = true
	}

	// Build a set of active scheduled jobs from the scheduler
	allSchedulerJobs := h.scheduler.ListAllJobs()
	activeScheduledNames := make(map[string]string) // name -> pattern
	for _, j := range allSchedulerJobs {
		activeScheduledNames[j.Name] = j.Pattern
	}

	var watchers []watcherStatus
	var scheduled []scheduledJobStatus

	for _, col := range cols {
		if col.IntakeConfigs == nil {
			continue
		}

		var intakes []intakeConfigEntry
		if err := json.Unmarshal(col.IntakeConfigs, &intakes); err != nil {
			continue
		}

		for i, intake := range intakes {
			switch intake.Method {
			case "immediate":
				key := fmt.Sprintf("%d:%s", col.CollectionID, intake.Path)
				status := "stopped"
				if activeWatcherPaths[key] {
					status = "active"
				}
				watchers = append(watchers, watcherStatus{
					CollectionID:   col.CollectionID,
					CollectionName: col.CollectionName,
					IntakePath:     intake.Path,
					IntakeIndex:    i,
					Status:         status,
				})

			case "scheduled":
				var cfg scheduledConfig
				if intake.Config != nil {
					_ = json.Unmarshal(intake.Config, &cfg)
				}
				if cfg.Schedule == "" {
					cfg.Schedule = "0 1 * * *"
				}

				jobName := fmt.Sprintf("cron-c%d-i%d", col.CollectionID, i)
				status := "stopped"
				if _, ok := activeScheduledNames[jobName]; ok {
					status = "active"
				}

				scheduled = append(scheduled, scheduledJobStatus{
					Name:           jobName,
					CollectionID:   col.CollectionID,
					CollectionName: col.CollectionName,
					IntakePath:     intake.Path,
					IntakeIndex:    i,
					Pattern:        cfg.Schedule,
					Status:         status,
				})
			}
		}
	}

	// Categorize scheduler jobs into frame and system
	var frameJobs []cronJobInfo
	var systemJobs []cronJobInfo

	for _, j := range allSchedulerJobs {
		if strings.HasPrefix(j.Name, "frame-") {
			frameJobs = append(frameJobs, cronJobInfo{
				Name:    j.Name,
				Pattern: j.Pattern,
			})
		} else if !strings.HasPrefix(j.Name, "intake_") {
			systemJobs = append(systemJobs, cronJobInfo{
				Name:    j.Name,
				Pattern: j.Pattern,
			})
		}
	}

	// Ensure non-nil slices for JSON output
	if watchers == nil {
		watchers = []watcherStatus{}
	}
	if scheduled == nil {
		scheduled = []scheduledJobStatus{}
	}
	if frameJobs == nil {
		frameJobs = []cronJobInfo{}
	}
	if systemJobs == nil {
		systemJobs = []cronJobInfo{}
	}

	c.JSON(http.StatusOK, jobsResponse{
		Watchers:  watchers,
		Scheduled: scheduled,
		Frame:     frameJobs,
		System:    systemJobs,
	})
}

// startAllWatchers starts file watchers for all collections.
// POST /api/admin/startAllWatchers
func (h *JobsHandler) startAllWatchers(c *gin.Context) {
	if err := h.fileWatcher.StartForAllCollections(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{
				"message": err.Error(),
				"code":    "WATCHER_START_FAILED",
			},
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "All watchers started"})
}

// stopAllWatchers stops all active file watchers.
// POST /api/admin/stopAllWatchers
func (h *JobsHandler) stopAllWatchers(c *gin.Context) {
	h.fileWatcher.StopAll()
	c.JSON(http.StatusOK, gin.H{"message": "All watchers stopped"})
}

// startScheduledIndexing schedules all cron jobs for scheduled intake paths.
func (h *JobsHandler) startScheduledIndexing(c *gin.Context) {
	if err := h.scheduledIndexing.ScheduleAll(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": gin.H{"message": err.Error(), "code": "INTERNAL_ERROR"},
		})
		return
	}
	c.Status(http.StatusOK)
}

// stopScheduledIndexing stops all scheduled indexing cron jobs.
func (h *JobsHandler) stopScheduledIndexing(c *gin.Context) {
	h.scheduledIndexing.StopAll()
	c.Status(http.StatusOK)
}
