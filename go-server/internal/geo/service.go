package geo

// Geo is a set of package-level functions for reverse-geocoding: GPS/country
// derivation, non-US resolution, US DB cache lookups, and the geonames API
// calls (findNearestAddress / postalCodeLookup). It holds NO rate-limit state
// and owns no queues -- the geo work runs as three pipeline queues (geo-cache,
// geo-lookup-addr, geo-lookup-city) and the geonames request budget is owned by
// the pipeline's geo rate gater. This package is purely the cache check and
// address-resolution logic.

// Pipeline hooks, wired by pipeline.Init at startup (function-var indirection
// avoids an import cycle: the pipeline imports geo, not vice versa).
var (
	// EnqueueLookup enqueues a geo-lookup for a uuid at the head of the geo
	// chain (the geo-cache queue). No-op if not wired.
	EnqueueLookup func(uuid string)
	// LookupStatus returns the geo-cache stage's status snapshot, or nil.
	LookupStatus func() map[string]interface{}
)
