# Geo Subsystem

## Overview

The geo subsystem resolves location metadata for media items that have GPS coordinates. It populates the `geo_` fields on the `metadata` table, which are used for search (FTS), grouping, and display.

## Architecture

```
file-indexer.mjs
  |
  +--> inserts metadata row (geo_ fields null)
  +--> inserts exiftool geolocation into geo_lookups
  +--> queues finalizeGeo via geo-queue-manager
         |
         v
geo-finalizer.mjs (finalizeGeo)
  |
  +-- Non-US: reads exiftool data from geo_lookups, writes geo_ fields
  |
  +-- US: cache check (exact/proximity match on metadata)
        |
        +-- Hit: copies geo_ fields from matched row
        |
        +-- Miss: calls geonames findNearestAddress API
                    |
                    +--> stores response in geo_lookups
                    +--> if placename empty: calls postalCodeLookup API
                    +--> writes all geo_ fields to metadata
```

## Files

| File | Purpose |
|------|---------|
| `server/app/core/geo/geo-finalizer.mjs` | Main logic: resolves geo_ fields for a uuid |
| `server/app/core/geo/geo-queue-manager.mjs` | Queue wrapper around finalizeGeo (with rate limit pause) |
| `server/app/core/geo/geo-encoding-db.mjs` | DB queries: cache lookups, inserts, updates |
| `server/app/core/geo/rate-limiter.mjs` | Geonames API rate limiting (hourly/daily counters) |

## APIs Used

| API | When | Endpoint |
|-----|------|----------|
| geonames findNearestAddress | US items, no cache hit | `api.geonames.org/findNearestAddressJSON?lat=&lng=&username=` |
| geonames postalCodeLookup | US items where findNearestAddress returns empty placename | `api.geonames.org/postalCodeLookupJSON?postalcode=&country=&username=` |

Both APIs are US-only and share the same rate limits (configurable hourly/daily).

## Field Derivation

### US items (via geonames findNearestAddress)

| metadata field | Source | JSON path |
|---|---|---|
| `geo_city` | findNearestAddress placename, or postalCodeLookup if empty | `$.address.placename` / `$.postalcodes[0].placeName` |
| `geo_region` | findNearestAddress | `$.address.adminName1` |
| `geo_country` | exiftool geolocation (geonames does not provide full country name) | `$.GeolocationCountry` |
| `geo_country_code` | findNearestAddress | `$.address.countryCode` |
| `geo_address` | Composite from findNearestAddress | See below |

**geo_address construction (US):**
```
[streetNumber] [street], [city OR adminName2], [adminName1], [countryCode]
```
Nulls/empties filtered out, joined with `, `.

### Non-US items (via exiftool geolocation)

| metadata field | Source | JSON path |
|---|---|---|
| `geo_city` | exiftool geolocation | `$.GeolocationCity` |
| `geo_region` | exiftool geolocation | `$.GeolocationRegion` |
| `geo_country` | exiftool geolocation | `$.GeolocationCountry` |
| `geo_country_code` | exiftool geolocation | `$.GeolocationCountryCode` |
| `geo_address` | Composite from exiftool | See below |

**geo_address construction (non-US):**
```
[City], [Subregion], [Region], [CountryCode], [Country]
```
Nulls filtered out, joined with `, `.

### Cache hits (exact/proximity match)

All geo_ fields copied verbatim from the matched row. No re-derivation.

## Database Tables

### geo_lookups

Stores raw responses from all geo sources. Created by migration 011.

```sql
CREATE TABLE geo_lookups (
  id INTEGER PRIMARY KEY,
  uuid TEXT NOT NULL,
  source TEXT NOT NULL,            -- 'exiftool' | 'geonames'
  api_name TEXT NOT NULL,          -- 'geolocation', 'findNearestAddress', 'postalCodeLookup'
  request_params TEXT,             -- JSON (for cache key / debugging)
  response_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  UNIQUE(uuid, api_name)
);
```

### metadata (geo_ columns)

Derived/searchable fields, populated by the finalizer:

| Column | Purpose |
|--------|---------|
| `geo_address` | Formatted address string (in FTS for search) |
| `geo_city` | City/placename (for grouping) |
| `geo_region` | State/province (for grouping) |
| `geo_country` | Full country name (for grouping) |
| `geo_country_code` | ISO 3166-1 alpha-2 (for filtering) |
| `geo_status` | Finalization status |
| `geo_matched_uuid` | UUID of row used for cache hit (null if own API call) |

## geo_status Values

| Status | Meaning |
|--------|---------|
| `FOUND_VIA_API` | Fresh geonames API call for this item |
| `FOUND_DB_EXACT_MATCH` | Matched another row at same coordinates (4dp) |
| `FOUND_DB_PROXIMITY_MATCH` | Matched another row within ~10m |
| `RESOLVED_FROM_EXIFTOOL` | Non-US, populated from exiftool data |
| `QUEUED_FOR_API` | Waiting for API call (transient) |
| `API_ERROR` | Geonames API returned an error |
| `NO_ADDRESS_FOUND` | Geonames returned empty response |

## Cache Design

### Address cache (metadata table)

For US items, before calling the API, the finalizer checks if another item at the same coordinates already has resolved geo_ fields:

1. **Exact match**: `ROUND(gps_lat, 4) = ROUND(?, 4)` (~11m grid)
2. **Proximity match**: haversine distance < 10m (TODO: consider increasing to 50-100m)

If found, all geo_ fields are copied from the matched row -- no API call needed.

### Postal code cache (geo_lookups table)

Before calling postalCodeLookupJSON, checks if any existing row in geo_lookups has the same `(postalcode, country)` in request_params:

```sql
WHERE api_name = 'postalCodeLookup'
AND json_extract(request_params, '$.postalcode') = ?
AND json_extract(request_params, '$.country') = ?
```

## Rate Limiting

Geonames API has hourly and daily request limits (configurable in runtime config). The queue manager pauses dispatch when limits are reached and resumes at the next hour/day boundary. Counters are persisted to `rate_limit_state.json` in the data directory.
