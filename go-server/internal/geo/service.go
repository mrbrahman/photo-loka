package geo

import (
	"log/slog"

	"photo-loka/internal/queue"
)

// Geo encoding operations are package-level functions backed by a dedicated
// queue and the finalizer state (rate limiter + geonames user), set via Init.
var (
	geoQueue *queue.Queue
	logger   = slog.Default().With("component", "geo-service")
)

// Init wires the geo queue, initializes the rate limiter from its state file,
// and sets the geonames username. Called once at startup.
func Init(q *queue.Queue, rateLimitStateFile, user string) {
	geoQueue = q
	geonamesUser = user
	initRateLimiter(rateLimitStateFile)
}

// Enqueue adds a single geo resolution task to the queue.
func Enqueue(uuid string, opts map[string]interface{}) {
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
			return FinalizeGeo(uuid, gpsLat, gpsLng, countryCode)
		},
		Priority:    queue.Normal,
		Description: "geo:" + uuid,
	}

	geoQueue.Enqueue(task)
}

// EnqueueMany adds multiple geo resolution tasks to the queue in bulk.
func EnqueueMany(entries []map[string]interface{}) {
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
				return FinalizeGeo(capturedUUID, gpsLat, gpsLng, countryCode)
			},
			Priority:    queue.Normal,
			Description: "geo:" + capturedUUID,
		}

		tasks = append(tasks, task)
	}

	if len(tasks) > 0 {
		geoQueue.EnqueueMany(tasks)
		logger.Info("enqueued geo tasks", "count", len(tasks))
	}
}

// Status returns the current queue status.
func Status() queue.Status {
	return geoQueue.GetStatus()
}

// QueueSizes returns the pending task counts by priority.
func QueueSizes() (high, normal, low int) {
	return geoQueue.QueueSizes()
}
