package scheduler

import (
	"fmt"
	"log/slog"
	"sync"

	"github.com/robfig/cron/v3"
)

// The cron scheduler is package-level (single instance). Init creates and
// starts the cron runner; the named-job registry and its guard are package vars.
var (
	cronRunner *cron.Cron
	jobs       = make(map[string]cron.EntryID) // name -> entry ID
	patterns   = make(map[string]string)       // name -> cron pattern
	mu         sync.Mutex
)

// log resolves the current default handler at call time (see frames.frLogger).
func log() *slog.Logger { return slog.Default().With("component", "scheduler") }

// JobInfo describes a registered cron job.
type JobInfo struct {
	Name    string `json:"name"`
	Pattern string `json:"pattern"`
}

// Init creates and starts the cron runner with a seconds-optional parser.
// Called once at startup.
func Init() {
	cronRunner = cron.New(cron.WithParser(cron.NewParser(
		cron.SecondOptional | cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow,
	)))
	cronRunner.Start()
}

// AddJob registers a named cron job with the given pattern and handler.
// If a job with the same name already exists, it is replaced.
func AddJob(name, pattern string, handler func()) error {
	mu.Lock()
	defer mu.Unlock()

	// Remove existing job with same name if present
	if existingID, exists := jobs[name]; exists {
		cronRunner.Remove(existingID)
		delete(jobs, name)
		delete(patterns, name)
	}

	entryID, err := cronRunner.AddFunc(pattern, handler)
	if err != nil {
		return fmt.Errorf("adding cron job %q with pattern %q: %w", name, pattern, err)
	}

	jobs[name] = entryID
	patterns[name] = pattern

	log().Debug("cron job added", "name", name, "pattern", pattern)
	return nil
}

// DeleteJob removes and stops a named job.
func DeleteJob(name string) {
	mu.Lock()
	defer mu.Unlock()

	if entryID, exists := jobs[name]; exists {
		cronRunner.Remove(entryID)
		delete(jobs, name)
		delete(patterns, name)
		log().Debug("cron job deleted", "name", name)
	}
}

// DeleteAllJobs removes and stops all registered jobs.
func DeleteAllJobs() {
	mu.Lock()
	defer mu.Unlock()

	for name, entryID := range jobs {
		cronRunner.Remove(entryID)
		log().Debug("cron job deleted", "name", name)
	}

	jobs = make(map[string]cron.EntryID)
	patterns = make(map[string]string)
}

// ListAllJobs returns information about all active cron jobs.
func ListAllJobs() []JobInfo {
	mu.Lock()
	defer mu.Unlock()

	result := make([]JobInfo, 0, len(jobs))
	for name := range jobs {
		result = append(result, JobInfo{
			Name:    name,
			Pattern: patterns[name],
		})
	}

	return result
}

// Stop stops the cron runner. No more jobs will execute after this call.
func Stop() {
	ctx := cronRunner.Stop()
	<-ctx.Done()
	log().Info("scheduler stopped")
}
