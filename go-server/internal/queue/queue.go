package queue

import (
	"log/slog"
	"sync"
	"sync/atomic"
	"time"
)

// Priority levels for task scheduling.
type Priority int

const (
	High   Priority = iota
	Normal
	Low
)

// maxErrors is the maximum number of recent errors to retain.
const maxErrors = 100

// TaskFn is a function executed by the queue.
type TaskFn func() error

// Task represents a unit of work with a priority level.
type Task struct {
	Fn          TaskFn
	Priority    Priority
	Description string
}

// Status represents the current state of the queue.
type Status struct {
	Pending        int   `json:"pending"`
	Active         int   `json:"active"`
	Completed      int64 `json:"completed"`
	Failed         int64 `json:"failed"`
	IsPaused       bool  `json:"is_paused"`
	MaxConcurrency int   `json:"max_concurrency"`
}

// Error records a failed task execution.
type Error struct {
	File      string    `json:"file"`
	ErrorMsg  string    `json:"error"`
	Timestamp time.Time `json:"timestamp"`
}

// Queue is a priority task queue with concurrency control.
type Queue struct {
	high   []Task
	normal []Task
	low    []Task
	mu     sync.Mutex

	sem            chan struct{} // buffered channel as concurrency semaphore
	active         atomic.Int32
	completed      atomic.Int64
	failed         atomic.Int64
	isPaused       atomic.Bool
	maxConcurrency int

	errors   []Error
	errorsMu sync.Mutex

	notify chan struct{}
	done   chan struct{}
	logger *slog.Logger
}

// New creates a new Queue with the given maximum concurrency and starts
// the background dispatch goroutine.
func New(maxConcurrency int) *Queue {
	q := &Queue{
		sem:            make(chan struct{}, maxConcurrency),
		maxConcurrency: maxConcurrency,
		notify:         make(chan struct{}, 1),
		done:           make(chan struct{}),
		logger:         slog.Default().With("component", "queue"),
	}
	go q.dispatch()
	return q
}

// Enqueue adds a single task to the queue according to its priority.
func (q *Queue) Enqueue(task Task) {
	q.mu.Lock()
	switch task.Priority {
	case High:
		q.high = append(q.high, task)
	case Low:
		q.low = append(q.low, task)
	default:
		q.normal = append(q.normal, task)
	}
	q.mu.Unlock()

	// Signal the dispatch loop (non-blocking).
	select {
	case q.notify <- struct{}{}:
	default:
	}
}

// EnqueueMany adds multiple tasks to the queue in bulk.
func (q *Queue) EnqueueMany(tasks []Task) {
	q.mu.Lock()
	for _, task := range tasks {
		switch task.Priority {
		case High:
			q.high = append(q.high, task)
		case Low:
			q.low = append(q.low, task)
		default:
			q.normal = append(q.normal, task)
		}
	}
	q.mu.Unlock()

	select {
	case q.notify <- struct{}{}:
	default:
	}
}

// Pause stops the queue from dispatching new tasks. Already running tasks
// continue to completion.
func (q *Queue) Pause() {
	q.isPaused.Store(true)
	q.logger.Info("queue paused")
}

// Resume allows the queue to dispatch tasks again.
func (q *Queue) Resume() {
	q.isPaused.Store(false)
	q.logger.Info("queue resumed")

	// Kick the dispatch loop.
	select {
	case q.notify <- struct{}{}:
	default:
	}
}

// SetConcurrency changes the maximum number of concurrent tasks.
// It replaces the semaphore channel. Active tasks finish with the old
// semaphore; new dispatches use the new one.
func (q *Queue) SetConcurrency(n int) {
	if n < 1 {
		n = 1
	}
	q.mu.Lock()
	q.maxConcurrency = n
	q.sem = make(chan struct{}, n)
	q.mu.Unlock()

	q.logger.Info("concurrency updated", "max_concurrency", n)

	// Kick the dispatch loop to take advantage of new capacity.
	select {
	case q.notify <- struct{}{}:
	default:
	}
}

// GetStatus returns the current queue status.
func (q *Queue) GetStatus() Status {
	q.mu.Lock()
	pending := len(q.high) + len(q.normal) + len(q.low)
	q.mu.Unlock()

	return Status{
		Pending:        pending,
		Active:         int(q.active.Load()),
		Completed:      q.completed.Load(),
		Failed:         q.failed.Load(),
		IsPaused:       q.isPaused.Load(),
		MaxConcurrency: q.maxConcurrency,
	}
}

// GetErrors returns the most recent errors (up to maxErrors).
func (q *Queue) GetErrors() []Error {
	q.errorsMu.Lock()
	defer q.errorsMu.Unlock()

	result := make([]Error, len(q.errors))
	copy(result, q.errors)
	return result
}

// Stop signals the dispatch goroutine to exit. Blocks until it has stopped.
func (q *Queue) Stop() {
	close(q.done)
}

// dispatch is the background loop that dequeues tasks and runs them
// within the concurrency limit.
func (q *Queue) dispatch() {
	for {
		select {
		case <-q.done:
			return
		case <-q.notify:
			q.drainQueue()
		}
	}
}

// drainQueue attempts to dispatch all pending tasks up to the concurrency limit.
func (q *Queue) drainQueue() {
	for {
		// Respect pause state.
		if q.isPaused.Load() {
			return
		}

		// Check if stopped.
		select {
		case <-q.done:
			return
		default:
		}

		task, ok := q.dequeue()
		if !ok {
			return
		}

		// Acquire semaphore slot (blocks if at max concurrency).
		q.mu.Lock()
		sem := q.sem
		q.mu.Unlock()

		select {
		case sem <- struct{}{}:
			// Got a slot, run the task.
		case <-q.done:
			// Queue stopping, put the task back.
			q.mu.Lock()
			q.high = append([]Task{task}, q.high...)
			q.mu.Unlock()
			return
		}

		q.active.Add(1)

		go func(t Task, s chan struct{}) {
			defer func() {
				<-s
				q.active.Add(-1)

				// Kick the dispatch loop in case more tasks are pending.
				select {
				case q.notify <- struct{}{}:
				default:
				}
			}()

			err := t.Fn()
			if err != nil {
				q.failed.Add(1)
				q.recordError(t.Description, err)
				q.logger.Error("task failed", "description", t.Description, "error", err)
			} else {
				q.completed.Add(1)
			}
		}(task, sem)
	}
}

// dequeue removes and returns the highest priority task available.
// Returns false if no tasks are pending.
func (q *Queue) dequeue() (Task, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()

	if len(q.high) > 0 {
		task := q.high[0]
		q.high = q.high[1:]
		return task, true
	}
	if len(q.normal) > 0 {
		task := q.normal[0]
		q.normal = q.normal[1:]
		return task, true
	}
	if len(q.low) > 0 {
		task := q.low[0]
		q.low = q.low[1:]
		return task, true
	}

	return Task{}, false
}

// recordError appends an error to the errors slice, trimming to maxErrors.
func (q *Queue) recordError(description string, err error) {
	q.errorsMu.Lock()
	defer q.errorsMu.Unlock()

	q.errors = append(q.errors, Error{
		File:      description,
		ErrorMsg:  err.Error(),
		Timestamp: time.Now(),
	})

	if len(q.errors) > maxErrors {
		q.errors = q.errors[len(q.errors)-maxErrors:]
	}
}
