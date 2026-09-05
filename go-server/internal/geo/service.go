package geo

import (
	"log/slog"

	"photo-loka/internal/queue"
)

// Service provides the public API for geo encoding operations and manages the queue.
type Service struct {
	finalizer *Finalizer
	queue     *queue.Queue
	logger    *slog.Logger
}

// NewService creates a new geo Service.
func NewService(finalizer *Finalizer, geoQueue *queue.Queue) *Service {
	return &Service{
		finalizer: finalizer,
		queue:     geoQueue,
		logger:    slog.Default().With("component", "geo-service"),
	}
}

// Enqueue adds a single geo resolution task to the queue.
func (s *Service) Enqueue(uuid string, opts map[string]interface{}) {
	var gpsLat, gpsLng *float64
	var countryCode *string

	if v, ok := opts["gps_lat"].(float64); ok {
		gpsLat = &v
	}
	if v, ok := opts["gps_lng"].(float64); ok {
		gpsLng = &v
	}
	if v, ok := opts["country_code"].(string); ok {
		countryCode = &v
	}

	task := queue.Task{
		Fn: func() error {
			return s.finalizer.FinalizeGeo(uuid, gpsLat, gpsLng, countryCode)
		},
		Priority:    queue.Normal,
		Description: "geo:" + uuid,
	}

	s.queue.Enqueue(task)
}

// EnqueueMany adds multiple geo resolution tasks to the queue in bulk.
func (s *Service) EnqueueMany(entries []map[string]interface{}) {
	tasks := make([]queue.Task, 0, len(entries))

	for _, entry := range entries {
		uuid, ok := entry["uuid"].(string)
		if !ok || uuid == "" {
			continue
		}

		// Capture loop variables for closure
		capturedUUID := uuid
		var gpsLat, gpsLng *float64
		var countryCode *string

		if v, ok := entry["gps_lat"].(float64); ok {
			lat := v
			gpsLat = &lat
		}
		if v, ok := entry["gps_lng"].(float64); ok {
			lng := v
			gpsLng = &lng
		}
		if v, ok := entry["country_code"].(string); ok {
			cc := v
			countryCode = &cc
		}

		task := queue.Task{
			Fn: func() error {
				return s.finalizer.FinalizeGeo(capturedUUID, gpsLat, gpsLng, countryCode)
			},
			Priority:    queue.Normal,
			Description: "geo:" + capturedUUID,
		}

		tasks = append(tasks, task)
	}

	if len(tasks) > 0 {
		s.queue.EnqueueMany(tasks)
		s.logger.Info("enqueued geo tasks", "count", len(tasks))
	}
}

// Status returns the current queue status.
func (s *Service) Status() queue.Status {
	return s.queue.GetStatus()
}

// QueueSizes returns the pending task counts by priority.
func (s *Service) QueueSizes() (high, normal, low int) {
	return s.queue.QueueSizes()
}
