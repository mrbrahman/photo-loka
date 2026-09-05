package scheduler

import (
	"fmt"
	"log/slog"
	"sync"

	"github.com/robfig/cron/v3"
)

// Scheduler wraps robfig/cron to manage named cron jobs.
type Scheduler struct {
	cron     *cron.Cron
	jobs     map[string]cron.EntryID // name -> entry ID
	patterns map[string]string       // name -> cron pattern
	mu       sync.Mutex
	logger   *slog.Logger
}

// JobInfo describes a registered cron job.
type JobInfo struct {
	Name    string `json:"name"`
	Pattern string `json:"pattern"`
}

// New creates and starts a new Scheduler with seconds-optional parser.
func New() *Scheduler {
	c := cron.New(cron.WithParser(cron.NewParser(
		cron.SecondOptional | cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow,
	)))
	c.Start()

	return &Scheduler{
		cron:     c,
		jobs:     make(map[string]cron.EntryID),
		patterns: make(map[string]string),
		logger:   slog.Default().With("component", "scheduler"),
	}
}

// AddJob registers a named cron job with the given pattern and handler.
// If a job with the same name already exists, it is replaced.
func (s *Scheduler) AddJob(name, pattern string, handler func()) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Remove existing job with same name if present
	if existingID, exists := s.jobs[name]; exists {
		s.cron.Remove(existingID)
		delete(s.jobs, name)
		delete(s.patterns, name)
	}

	entryID, err := s.cron.AddFunc(pattern, handler)
	if err != nil {
		return fmt.Errorf("adding cron job %q with pattern %q: %w", name, pattern, err)
	}

	s.jobs[name] = entryID
	s.patterns[name] = pattern

	s.logger.Debug("cron job added", "name", name, "pattern", pattern)
	return nil
}

// DeleteJob removes and stops a named job.
func (s *Scheduler) DeleteJob(name string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if entryID, exists := s.jobs[name]; exists {
		s.cron.Remove(entryID)
		delete(s.jobs, name)
		delete(s.patterns, name)
		s.logger.Debug("cron job deleted", "name", name)
	}
}

// DeleteAllJobs removes and stops all registered jobs.
func (s *Scheduler) DeleteAllJobs() {
	s.mu.Lock()
	defer s.mu.Unlock()

	for name, entryID := range s.jobs {
		s.cron.Remove(entryID)
		s.logger.Debug("cron job deleted", "name", name)
	}

	s.jobs = make(map[string]cron.EntryID)
	s.patterns = make(map[string]string)
}

// ListAllJobs returns information about all active cron jobs.
func (s *Scheduler) ListAllJobs() []JobInfo {
	s.mu.Lock()
	defer s.mu.Unlock()

	result := make([]JobInfo, 0, len(s.jobs))
	for name := range s.jobs {
		result = append(result, JobInfo{
			Name:    name,
			Pattern: s.patterns[name],
		})
	}

	return result
}

// Stop stops the cron runner. No more jobs will execute after this call.
func (s *Scheduler) Stop() {
	ctx := s.cron.Stop()
	<-ctx.Done()
	s.logger.Info("scheduler stopped")
}
