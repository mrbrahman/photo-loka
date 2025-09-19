import { db } from './sqlite-database.mjs';
import fs from 'fs';
import path from 'path';
import { config } from '../config.mjs';

// Prepare statements once for better performance
const findExactGeoMatchStmt = db.prepare(`
  SELECT uuid, geonames_rev_address_json 
  FROM metadata 
  WHERE ROUND(gps_lat, 4) = ROUND(?, 4) 
  AND ROUND(gps_long, 4) = ROUND(?, 4)
  AND geonames_rev_address_json IS NOT NULL
  LIMIT 1
`);

// Proximity matching using haversine formula for accurate distance calculation
// First filters by coordinate bounds (~10m) for performance, then calculates exact distance
const findProximityGeoMatchStmt = db.prepare(`
  SELECT uuid, geonames_rev_address_json
  FROM metadata 
  WHERE geonames_rev_address_json IS NOT NULL
  AND ABS(gps_lat - ?) < 0.00009    -- Pre-filter: ~10m coordinate bounds for performance
  AND ABS(gps_long - ?) < 0.00009   -- Pre-filter: ~10m coordinate bounds for performance
  AND 6371000 * 2 * ASIN(           -- Haversine formula: Earth radius (6371km) * great circle distance
    SQRT(
      POWER(SIN(RADIANS(? - gps_lat) / 2), 2) +                    -- Latitude difference component
      COS(RADIANS(gps_lat)) * COS(RADIANS(?)) *                       -- Longitude adjustment for latitude
      POWER(SIN(RADIANS(? - gps_long) / 2), 2)                       -- Longitude difference component
    )
  ) < 10                            -- Final filter: within 10 meters actual distance
  LIMIT 1
`);

const updateGeoAddressStmt = db.prepare(`UPDATE metadata SET geo_address = ?, geonames_encoding_status = ?, geonames_db_matched_uuid = ? WHERE uuid = ?`);

const updateGeonamesDataStmt = db.prepare(`UPDATE metadata SET geonames_rev_address_json = ?, geo_address = ?, geonames_encoding_status = ? WHERE uuid = ?`);

const updateGeoEncodingStatusStmt = db.prepare(`UPDATE metadata SET geonames_encoding_status = ? WHERE uuid = ?`);

const rateLimitFile = path.join(path.dirname(config.dbFile), 'rate_limit_state.json');

export function findExactGeoMatch(gps_lat, gps_long) {
  return findExactGeoMatchStmt.get(gps_lat, gps_long);
}

export function findProximityGeoMatch(gps_lat, gps_long) {
  return findProximityGeoMatchStmt.get(gps_lat, gps_long, gps_lat, gps_lat, gps_long);
}

export function updateGeoAddress(uuid, geo_address, status = 'FOUND_DB_EXACT_MATCH', matched_uuid = null) {
  updateGeoAddressStmt.run(geo_address, status, matched_uuid, uuid);
}

export function updateGeonamesData(uuid, geonames_json, geo_address) {
  updateGeonamesDataStmt.run(geonames_json, geo_address, 'FOUND_VIA_API', uuid);
}

export function updateGeoEncodingStatus(uuid, status) {
  updateGeoEncodingStatusStmt.run(status, uuid);
}

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