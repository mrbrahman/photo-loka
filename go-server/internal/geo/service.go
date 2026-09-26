package geo

import (
	"log/slog"
	"path/filepath"

	"photo-loka/internal/config"
)

// Geo resolution is a set of package-level functions. The geonames username and
// data dir come from config.Startup; the geonames rate limit is enforced inside
// FinalizeGeo (see ratelimiter.go), so the geo work queue lives in the pipeline
// (the geo-lookup stage) rather than here.

// log resolves the current default handler at call time (see frames.frLogger).
func log() *slog.Logger { return slog.Default().With("component", "geo-service") }

// Pipeline hooks, wired by pipeline.Init at startup (function-var indirection
// avoids an import cycle: the pipeline imports geo, not vice versa). The geo
// reverse-geo-encoding endpoints enqueue onto / read the pipeline's geo-lookup
// stage through these, so all queue ownership stays in the pipeline.
var (
	// EnqueueLookup enqueues a geo-lookup for a uuid on the pipeline's
	// geo-lookup stage (Normal priority). No-op if not wired.
	EnqueueLookup func(uuid string)
	// LookupStatus returns the geo-lookup stage's status snapshot, or nil.
	LookupStatus func() map[string]interface{}
)

// Init initializes the geonames rate limiter from its state file (under
// config.Startup.DataDir). Called once at startup. Geo no longer owns a work
// queue: the pipeline's geo-lookup stage runs FinalizeGeo on a single-worker
// queue, and the rate limit is honored inside FinalizeGeo itself.
func Init() {
	initRateLimiter(filepath.Join(config.Startup.DataDir, "rate_limit_state.json"))
}
