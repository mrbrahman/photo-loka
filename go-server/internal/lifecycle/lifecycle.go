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
	"photo-loka/internal/pipeline"
	"photo-loka/internal/scheduler"
)

// Deps bundles the remaining stateful collaborators that startup/shutdown act
// on. Indexing work now runs through per-stage queues owned by the pipeline
// (including the geo-lookup stage, which reuses the geo queue), all stopped via
// pipeline.P.StopAll. Nothing queue-shaped needs to flow through here anymore,
// but the struct is kept as the startup/shutdown seam.
type Deps struct{}

// StartupActions runs the once-at-boot orchestration: start (or mark stopped)
// intake watchers and scheduled indexing per runtime config, load frames and
// schedule their cron jobs, and register the daily token-cleanup job.
func StartupActions(d Deps, cleanupTokens func()) {
	if config.Runtime.StartFileWatcherAtStartup {
		if err := jobs.StartForAllCollections(); err != nil {
			slog.Error("failed to start file watchers", "error", err)
		}
	} else {
		// Mark immediate intakes as stopped in DB when watchers are disabled
		collections.SetIntakeStatusByMethod("immediate", "stopped")
		slog.Info("file watcher at startup disabled - marked immediate intakes as stopped")
	}

	if config.Runtime.StartScheduledIndexingAtStartup {
		if err := jobs.ScheduleAll(); err != nil {
			slog.Error("failed to schedule intake indexing", "error", err)
		}
	} else {
		// Mark scheduled intakes as stopped in DB when scheduling is disabled
		collections.SetIntakeStatusByMethod("scheduled", "stopped")
		slog.Info("scheduled indexing at startup disabled - marked scheduled intakes as stopped")
	}

	if err := frames.LoadAllFrames(); err != nil {
		slog.Error("failed to load frames", "error", err)
	}

	// Schedule frame cron jobs (reset, pause/resume)
	frames.ScheduleAllFrameJobs()

	// Schedule token cleanup (daily at 3am)
	scheduler.AddJob("token-cleanup", "0 3 * * *", cleanupTokens)
}

// ShutdownCleanup stops background workers and persists state after the HTTP
// server has stopped serving.
func ShutdownCleanup(d Deps) {
	scheduler.Stop()
	jobs.StopAll()          // stop file watchers
	jobs.StopAllScheduled() // stop scheduled intake cron jobs
	geo.SaveRateLimiter()   // persist rate limit counters for next startup
	if pipeline.P != nil {
		pipeline.P.StopAll() // stop all per-stage queues (includes geo-lookup)
	}
}
