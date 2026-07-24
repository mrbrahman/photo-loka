package admin

import (
	"encoding/json"
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
	scheduler    *scheduler.Scheduler
	fileWatcher  *jobs.FileWatcher
	colDB        *collections.CollectionsDB
	frameManager *frames.Manager
}

// NewJobsHandler creates a new JobsHandler.
func NewJobsHandler(sched *scheduler.Scheduler, fw *jobs.FileWatcher, colDB *collections.CollectionsDB, fm *frames.Manager) *JobsHandler {
	return &JobsHandler{
		scheduler:    sched,
		fileWatcher:  fw,
		colDB:        colDB,
		frameManager: fm,
	}
}

// RegisterRoutes registers job management routes on the given router group.
func (h *JobsHandler) RegisterRoutes(rg *gin.RouterGroup) {
	rg.GET("/jobs", h.getJobs)
	rg.POST("/startAllWatchers", h.startAllWatchers)
	rg.POST("/stopAllWatchers", h.stopAllWatchers)
}

// watcherStatus describes an intake watcher and its current state.
type watcherStatus struct {
	CollectionID   int64  `json:"collection_id"`
	CollectionName string `json:"collection_name"`
	IntakePath     string `json:"intake_path"`
	Status         string `json:"status"` // "active" or "stopped"
}

// scheduledJobStatus describes a scheduled intake job and its current state.
type scheduledJobStatus struct {
	CollectionID   int64  `json:"collection_id"`
	CollectionName string `json:"collection_name"`
	IntakePath     string `json:"intake_path"`
	Schedule       string `json:"schedule"`
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
		activeWatcherPaths[w.IntakePath] = true
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

		for _, intake := range intakes {
			switch intake.Method {
			case "immediate":
				status := "stopped"
				if activeWatcherPaths[intake.Path] {
					status = "active"
				}
				watchers = append(watchers, watcherStatus{
					CollectionID:   col.CollectionID,
					CollectionName: col.CollectionName,
					IntakePath:     intake.Path,
					Status:         status,
				})

			case "scheduled":
				var cfg scheduledConfig
				if intake.Config != nil {
					_ = json.Unmarshal(intake.Config, &cfg)
				}

				// Check if this job is in the scheduler
				status := "stopped"
				for name := range activeScheduledNames {
					// Job names follow pattern "intake_{collectionID}_{index}"
					if strings.HasPrefix(name, "intake_") && activeScheduledNames[name] == cfg.Schedule {
						status = "active"
						break
					}
				}

				scheduled = append(scheduled, scheduledJobStatus{
					CollectionID:   col.CollectionID,
					CollectionName: col.CollectionName,
					IntakePath:     intake.Path,
					Schedule:       cfg.Schedule,
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
