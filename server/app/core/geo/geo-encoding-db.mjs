import { asyncGet, asyncRun } from '#db/db-pool';
import fs from 'fs';
import path from 'path';
import { startupConfig } from '#startup-config';

const rateLimitFile = path.join(path.dirname(startupConfig.dbFile), 'rate_limit_state.json');

// ---------------------------------------------------------------------------
// Cache lookups (metadata table)
// ---------------------------------------------------------------------------

// Find a previously resolved geo match for coordinates within 4 decimal
// places (~11m precision)
export async function findExactGeoMatch(gps_lat, gps_lng) {
  return await asyncGet(`
    SELECT uuid, geo_address, geo_city, geo_region, geo_country, geo_country_code
    FROM metadata
    WHERE geo_address IS NOT NULL
    AND ROUND(gps_lat, 4) = ROUND(?, 4)
    AND ROUND(gps_lng, 4) = ROUND(?, 4)
    LIMIT 1
  `, gps_lat, gps_lng);
}

// Proximity matching using haversine formula for distance calculation.
// Filters by coordinate bounds (~10m) for performance, then calculates exact distance.
// TODO: 10m threshold is nearly the same as the exact match (~11m). Consider increasing
// to 50-100m so this actually catches "same block" scenarios that the exact match misses.
export async function findProximityGeoMatch(gps_lat, gps_lng) {
  return await asyncGet(`
    SELECT uuid, geo_address, geo_city, geo_region, geo_country, geo_country_code
    FROM metadata
    WHERE geo_address IS NOT NULL
    AND ABS(gps_lat - ?) < 0.00009
    AND ABS(gps_lng - ?) < 0.00009
    AND 6371000 * 2 * ASIN(
      SQRT(
        POWER(SIN(RADIANS(? - gps_lat) / 2), 2) +
        COS(RADIANS(gps_lat)) * COS(RADIANS(?)) *
        POWER(SIN(RADIANS(? - gps_lng) / 2), 2)
      )
    ) < 10
    LIMIT 1
  `, gps_lat, gps_lng, gps_lat, gps_lat, gps_lng);
}

// ---------------------------------------------------------------------------
// Cache lookups (geo_lookups table)
// ---------------------------------------------------------------------------

// Find an existing postalCodeLookup response by postalcode + country
export async function findPostalCodeMatch(postalcode, country) {
  return await asyncGet(`
    SELECT response_json
    FROM geo_lookups
    WHERE api_name = 'postalCodeLookup'
    AND json_extract(request_params, '$.postalcode') = ?
    AND json_extract(request_params, '$.country') = ?
    LIMIT 1
  `, postalcode, country);
}

// ---------------------------------------------------------------------------
// Storing lookup results
// ---------------------------------------------------------------------------

export async function insertGeoLookup(uuid, source, api_name, request_params, response_json) {
  return await asyncRun(`
    INSERT OR REPLACE INTO geo_lookups (uuid, source, api_name, request_params, response_json, fetched_at)
    VALUES (?, ?, ?, ?, ?, datetime('now','localtime'))
  `, uuid, source, api_name, request_params, response_json);
}

// ---------------------------------------------------------------------------
// Updating derived geo fields on metadata
// ---------------------------------------------------------------------------

// Update derived geo fields on metadata. Uses COALESCE for geo_country and
// geo_country_code so that passing null does not overwrite values already set
// at index time (from exiftool).
export async function updateGeoFields(uuid, fields) {
  return await asyncRun(`
    UPDATE metadata
    SET geo_address = ?,
        geo_city = ?,
        geo_region = ?,
        geo_country = COALESCE(?, geo_country),
        geo_country_code = COALESCE(?, geo_country_code),
        geo_status = ?,
        geo_matched_uuid = ?
    WHERE uuid = ?
  `, fields.geo_address, fields.geo_city, fields.geo_region,
     fields.geo_country, fields.geo_country_code,
     fields.geo_status, fields.geo_matched_uuid, uuid);
}

export async function updateGeoEncodingStatus(uuid, status) {
  return await asyncRun(`UPDATE metadata SET geo_status = ? WHERE uuid = ?`, status, uuid);
}

// ---------------------------------------------------------------------------
// Rate limit persistence
// ---------------------------------------------------------------------------

export function saveRateLimitCounters(hourlyCount, dailyCount, currentHour, currentDay) {
  const data = { hourly_count: hourlyCount, daily_count: dailyCount, current_hour: currentHour, current_day: currentDay };
  fs.writeFileSync(rateLimitFile, JSON.stringify(data));
}

export function loadRateLimitCounters() {
  try {
    return JSON.parse(fs.readFileSync(rateLimitFile, 'utf8'));
  } catch {
    return null;
  }
}
