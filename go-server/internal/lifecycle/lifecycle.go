// Package lifecycle centralizes the server's startup and shutdown
// orchestration so main.go stays lean. It wires the genuine stateful objects
// (queues, watchers, scheduler, rate limiter, frame manager) together for the
// serve command.
package lifecycle

import (
	"log/slog"

	"photo-loka/internal/collections"
	"photo-loka/internal/config"
	"photo-loka/internal/frames"
	"photo-loka/internal/geo"
	"photo-loka/internal/jobs"
	"photo-loka/internal/queue"
	"photo-loka/internal/scheduler"
)

// Deps bundles the stateful collaborators that startup/shutdown act on. They
// are created in main and handed here for orchestration.
type Deps struct {
	Scheduler         *scheduler.Scheduler
	FileWatcher       *jobs.FileWatcher
	ScheduledIndexing *jobs.ScheduledIndexing
	FrameManager      *frames.Manager
	IndexQueue        *queue.Queue
	VideoQueue        *queue.Queue
	GeoQueue          *queue.Queue
}

// StartupActions runs the once-at-boot orchestration: start (or mark stopped)
// intake watchers and scheduled indexing per runtime config, load frames and
// schedule their cron jobs, and register the daily token-cleanup job.
func StartupActions(d Deps, cleanupTokens func()) {
	if config.Rt.StartFileWatcherAtStartup {
		if err := d.FileWatcher.StartForAllCollections(); err != nil {
			slog.Error("failed to start file watchers", "error", err)
		}
	} else {
		// Mark immediate intakes as stopped in DB when watchers are disabled
		collections.SetIntakeStatusByMethod("immediate", "stopped")
		slog.Info("file watcher at startup disabled - marked immediate intakes as stopped")
	}

	if config.Rt.StartScheduledIndexingAtStartup {
		if err := d.ScheduledIndexing.ScheduleAll(); err != nil {
			slog.Error("failed to schedule intake indexing", "error", err)
		}
	} else {
		// Mark scheduled intakes as stopped in DB when scheduling is disabled
		collections.SetIntakeStatusByMethod("scheduled", "stopped")
		slog.Info("scheduled indexing at startup disabled - marked scheduled intakes as stopped")
	}

	if err := d.FrameManager.LoadAllFrames(); err != nil {
		slog.Error("failed to load frames", "error", err)
	}

	// Schedule frame cron jobs (reset, pause/resume)
	d.FrameManager.ScheduleAllFrameJobs()

	// Schedule token cleanup (daily at 3am)
	d.Scheduler.AddJob("token-cleanup", "0 3 * * *", cleanupTokens)
}

// ShutdownCleanup stops background workers and persists state after the HTTP
// server has stopped serving.
func ShutdownCleanup(d Deps) {
	d.Scheduler.Stop()
	d.FileWatcher.StopAll()
	d.ScheduledIndexing.StopAll()
	geo.SaveRateLimiter() // persist rate limit counters for next startup
	d.IndexQueue.Stop()
	d.VideoQueue.Stop()
	d.GeoQueue.Stop()
}
