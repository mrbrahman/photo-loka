package jobs

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"

	"photo-loka/internal/collections"
	"photo-loka/internal/indexing"
	"photo-loka/internal/scheduler"
)

// ScheduledIndexing manages cron-based intake indexing for collections.
type ScheduledIndexing struct {
	scheduler *scheduler.Scheduler
	indexer   *indexing.Indexer
	colDB     *collections.CollectionsDB
	jobs      map[string]int64 // jobName -> collection_id
	mu        sync.Mutex
	logger    *slog.Logger
}

// NewScheduledIndexing creates a new ScheduledIndexing manager.
func NewScheduledIndexing(sched *scheduler.Scheduler, indexer *indexing.Indexer, colDB *collections.CollectionsDB) *ScheduledIndexing {
	return &ScheduledIndexing{
		scheduler: sched,
		indexer:   indexer,
		colDB:     colDB,
		jobs:      make(map[string]int64),
		logger:    slog.Default().With("component", "scheduled-indexing"),
	}
}

// ScheduleAll schedules intake indexing for all collections with scheduled intake paths.
func (si *ScheduledIndexing) ScheduleAll() error {
	cols, err := si.colDB.GetAll()
	if err != nil {
		return fmt.Errorf("getting collections for scheduling: %w", err)
	}

	for i := range cols {
		si.ScheduleForCollection(&cols[i])
	}

	return nil
}

// ScheduleForCollection schedules cron jobs for each scheduled intake path in the collection.
func (si *ScheduledIndexing) ScheduleForCollection(col *collections.Collection) {
	if col.IntakeConfigs == nil {
		return
	}

	var intakeConfigs []scheduledIntakeConfig
	if err := json.Unmarshal(col.IntakeConfigs, &intakeConfigs); err != nil {
		si.logger.Error("failed to parse intake_configs",
			"collection_id", col.CollectionID,
			"error", err,
		)
		return
	}

	for i, cfg := range intakeConfigs {
		if cfg.Method != "scheduled" {
			continue
		}

		schedule := cfg.Config.Schedule
		if schedule == "" {
			si.logger.Warn("scheduled intake has no schedule",
				"collection_id", col.CollectionID,
				"path", cfg.Path,
			)
			continue
		}

		staleDays := cfg.Config.StaleDays
		if staleDays <= 0 {
			staleDays = 1
		}

		jobName := fmt.Sprintf("intake_%d_%d", col.CollectionID, i)
		collectionID := col.CollectionID
		intakePath := cfg.Path
		days := staleDays

		err := si.scheduler.AddJob(jobName, schedule, func() {
			// Check if indexer is idle before starting intake indexing
			status := si.indexer.IndexQueue().GetStatus()
			if status.Pending+status.Active > 0 {
				si.logger.Debug("skipping scheduled intake - indexer busy",
					"collection_id", collectionID,
					"path", intakePath,
					"pending", status.Pending,
					"active", status.Active,
				)
				return
			}

			if err := si.indexer.StartIntakeFileIndexing(collectionID, intakePath, days); err != nil {
				si.logger.Error("scheduled intake indexing failed",
					"collection_id", collectionID,
					"path", intakePath,
					"error", err,
				)
			}
		})

		if err != nil {
			si.logger.Error("failed to schedule intake job",
				"collection_id", col.CollectionID,
				"path", cfg.Path,
				"schedule", schedule,
				"error", err,
			)
			continue
		}

		si.mu.Lock()
		si.jobs[jobName] = col.CollectionID
		si.mu.Unlock()

		si.logger.Info("scheduled intake indexing",
			"collection_id", col.CollectionID,
			"path", cfg.Path,
			"schedule", schedule,
			"stale_days", staleDays,
		)
	}
}

// StopForCollection removes all scheduled jobs for a specific collection.
func (si *ScheduledIndexing) StopForCollection(collectionID int64) {
	si.mu.Lock()
	defer si.mu.Unlock()

	for jobName, colID := range si.jobs {
		if colID == collectionID {
			si.scheduler.DeleteJob(jobName)
			delete(si.jobs, jobName)
			si.logger.Info("removed scheduled job", "job", jobName, "collection_id", collectionID)
		}
	}
}

// StopAll removes all scheduled intake jobs.
func (si *ScheduledIndexing) StopAll() {
	si.mu.Lock()
	defer si.mu.Unlock()

	for jobName := range si.jobs {
		si.scheduler.DeleteJob(jobName)
	}
	si.jobs = make(map[string]int64)
	si.logger.Info("all scheduled intake jobs stopped")
}

// ListJobs returns a map of job names to their collection IDs.
func (si *ScheduledIndexing) ListJobs() map[string]int64 {
	si.mu.Lock()
	defer si.mu.Unlock()

	result := make(map[string]int64, len(si.jobs))
	for k, v := range si.jobs {
		result[k] = v
	}
	return result
}

// scheduledIntakeConfig represents a single intake configuration with schedule details.
type scheduledIntakeConfig struct {
	Path   string               `json:"path"`
	Method string               `json:"method"`
	Config scheduledConfigInner `json:"config"`
}

type scheduledConfigInner struct {
	Schedule  string `json:"schedule"`
	StaleDays int    `json:"staleDays"`
}
