package geo

import (
	"log/slog"
	"path/filepath"
	"time"

	"photo-loka/internal/config"
	"photo-loka/internal/queue"
)

// Geo resolution is a set of package-level functions plus two internal,
// rate-gated API queues (single instance for the process, so package-level per
// the project's no-boilerplate-classes rule).
//
// Division of labor with the pipeline: the pipeline's geo-lookup stage runs the
// LOCAL phase of FinalizeGeo (GPS derivation, non-US resolve, US exact/proximity
// cache). Only on a US cache MISS does geo take over, handing the item to its
// own internal API queues. Those queues are owned here (not the pipeline)
// because geo owns the geonames rate-limit condition and the rollover timer.
//
// Two queues, one per geonames endpoint, each concurrency 1 and each gated by
// the SAME rate limiter:
//   - addressQueue: findNearestAddress. On success it writes the geo_lookups
//     cache row; if the result needs a city lookup it hands off to cityQueue
//     WITHOUT writing the item's final address (2b); otherwise it writes the
//     final address itself (terminal).
//   - cityQueue: postalCodeLookup. Terminal: writes the final address.
//
// A gated item simply waits in its queue (final address stays blank) until the
// rollover timer resets the counters and kicks both queues. No mark-and-skip,
// no provisional write, no degrade.

// log resolves the current default handler at call time (see frames.frLogger).
func log() *slog.Logger { return slog.Default().With("component", "geo-service") }

// Internal API queues (single instance; created in Init). Both are concurrency
// 1 -- required for the rate gate to be meaningful and to serialize same-place
// cache writes.
var (
	addressQueue *queue.Queue
	cityQueue    *queue.Queue
)

// Pipeline hooks, wired by pipeline.Init at startup (function-var indirection
// avoids an import cycle: the pipeline imports geo, not vice versa). The geo
// reverse-geo-encoding endpoints enqueue onto / read the pipeline's geo-lookup
// stage through these; that stage runs FinalizeGeo's local phase.
var (
	// EnqueueLookup enqueues a geo-lookup for a uuid on the pipeline's
	// geo-lookup stage (Normal priority). No-op if not wired.
	EnqueueLookup func(uuid string)
	// LookupStatus returns the geo-lookup stage's status snapshot, or nil.
	LookupStatus func() map[string]interface{}
)

// Init initializes the geonames rate limiter from its state file (under
// config.Startup.DataDir), creates the two internal rate-gated API queues, and
// starts the hour/day rollover timer that resets the counters and kicks both
// queues so held items auto-resume. Called once at startup.
func Init() {
	initRateLimiter(filepath.Join(config.Startup.DataDir, "rate_limit_state.json"))

	// Both API queues share the read-only rateCheck as their "rate" gate: when
	// over budget the gate is closed and items wait (not consumed). The actual
	// budget consumption is the atomic rateReserve inside each task.
	addressQueue = queue.New("geo-address-api", 1)
	cityQueue = queue.New("geo-city-api", 1)
	addressQueue.RegisterGate("rate", rateCheck)
	cityQueue.RegisterGate("rate", rateCheck)

	startRolloverTimer()
}

// startRolloverTimer runs a process-lifetime goroutine that, just after each
// hour boundary, resets the rolled-over counters and kicks both API queues so
// any items held by the closed "rate" gate re-evaluate and resume. A single
// hourly tick covers both resets: resetCounters zeroes the daily counter only
// when the day has also rolled over. The small buffer past the boundary mirrors
// the Node.js reference (+30s) so we are safely into the new hour/day.
func startRolloverTimer() {
	go func() {
		for {
			now := time.Now()
			nextHour := now.Truncate(time.Hour).Add(time.Hour)
			wait := time.Until(nextHour) + 30*time.Second
			time.Sleep(wait)

			resetCounters()
			// Kick both queues so gated items resume now that budget is restored.
			if addressQueue != nil {
				addressQueue.Kick()
			}
			if cityQueue != nil {
				cityQueue.Kick()
			}
			log().Debug("geonames rate counters rolled over; kicked API queues")
		}
	}()
}
