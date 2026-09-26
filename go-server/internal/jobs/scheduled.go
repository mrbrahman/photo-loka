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

// Cron-based intake indexing is package-level (single instance): the jobName ->
// collection_id registry and its guard are package vars.
var (
	scheduledJobs = make(map[string]int64) // jobName -> collection_id
	scheduledMu   sync.Mutex
)

// siLogger resolves the current default handler at call time (see frames.frLogger).
func siLogger() *slog.Logger { return slog.Default().With("component", "scheduled-indexing") }

// ScheduleAll schedules intake indexing for all collections with scheduled intake paths.
func ScheduleAll() error {
	cols, err := collections.GetAll()
	if err != nil {
		return fmt.Errorf("getting collections for scheduling: %w", err)
	}

	for i := range cols {
		ScheduleForCollection(&cols[i])
	}

	return nil
}

// ScheduleForCollection schedules cron jobs for each scheduled intake path in the collection.
func ScheduleForCollection(col *collections.Collection) {
	if col.IntakeConfigs == nil {
		return
	}

	var intakeConfigs []scheduledIntakeConfig
	if err := json.Unmarshal(col.IntakeConfigs, &intakeConfigs); err != nil {
		siLogger().Error("failed to parse intake_configs",
			"collection_id", col.CollectionID,
			"error", err,
		)
		return
	}

	for i, cfg := range intakeConfigs {
		if cfg.Method != "scheduled" {
			continue
		}
		if cfg.Status == "stopped" {
			continue
		}

		schedule := cfg.Config.Schedule
		if schedule == "" {
			siLogger().Warn("scheduled intake has no schedule",
				"collection_id", col.CollectionID,
				"path", cfg.Path,
			)
			continue
		}

		staleDays := cfg.Config.StaleDays

		jobName := fmt.Sprintf("cron-c%d-i%d", col.CollectionID, i)
		collectionID := col.CollectionID
		intakePath := cfg.Path
		days := staleDays

		err := scheduler.AddJob(jobName, schedule, func() {
			// Check if indexer is idle before starting intake indexing
			if indexing.IndexerBusy() {
				siLogger().Debug("skipping scheduled intake - indexer busy",
					"collection_id", collectionID,
					"path", intakePath,
				)
				return
			}

			if err := indexing.StartIntakeFileIndexing(collectionID, intakePath, days); err != nil {
				siLogger().Error("scheduled intake indexing failed",
					"collection_id", collectionID,
					"path", intakePath,
					"error", err,
				)
			}
		})

		if err != nil {
			siLogger().Error("failed to schedule intake job",
				"collection_id", col.CollectionID,
				"path", cfg.Path,
				"schedule", schedule,
				"error", err,
			)
			continue
		}

		scheduledMu.Lock()
		scheduledJobs[jobName] = col.CollectionID
		scheduledMu.Unlock()

		siLogger().Info("scheduled intake indexing",
			"collection_id", col.CollectionID,
			"path", cfg.Path,
			"schedule", schedule,
			"stale_days", staleDays,
		)
	}
}

// StopForCollection removes all scheduled jobs for a specific collection.
func StopScheduledForCollection(collectionID int64) {
	scheduledMu.Lock()
	defer scheduledMu.Unlock()

	for jobName, colID := range scheduledJobs {
		if colID == collectionID {
			scheduler.DeleteJob(jobName)
			delete(scheduledJobs, jobName)
			siLogger().Info("removed scheduled job", "job", jobName, "collection_id", collectionID)
		}
	}
}

// StopAll removes all scheduled intake jobs.
func StopAllScheduled() {
	scheduledMu.Lock()
	defer scheduledMu.Unlock()

	for jobName := range scheduledJobs {
		scheduler.DeleteJob(jobName)
	}
	scheduledJobs = make(map[string]int64)
	siLogger().Info("all scheduled intake jobs stopped")
}

// ListJobs returns a map of job names to their collection IDs.
func ListJobs() map[string]int64 {
	scheduledMu.Lock()
	defer scheduledMu.Unlock()

	result := make(map[string]int64, len(scheduledJobs))
	for k, v := range scheduledJobs {
		result[k] = v
	}
	return result
}

// scheduledIntakeConfig represents a single intake configuration with schedule details.
type scheduledIntakeConfig struct {
	Path   string               `json:"path"`
	Method string               `json:"method"`
	Status string               `json:"status"`
	Config scheduledConfigInner `json:"config"`
}

type scheduledConfigInner struct {
	Schedule  string `json:"schedule"`
	StaleDays int    `json:"staleDays"`
}
