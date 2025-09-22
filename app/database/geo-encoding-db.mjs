import { asyncGet, asyncRun } from './db-pool.mjs';
import fs from 'fs';
import path from 'path';
import { config } from '../config.mjs';

const rateLimitFile = path.join(path.dirname(config.dbFile), 'rate_limit_state.json');

export async function findExactGeoMatch(gps_lat, gps_long) {
  return await asyncGet(`
    SELECT uuid, geonames_rev_address_json 
    FROM metadata 
    WHERE ROUND(gps_lat, 4) = ROUND(?, 4) 
    AND ROUND(gps_long, 4) = ROUND(?, 4)
    AND geonames_rev_address_json IS NOT NULL
    LIMIT 1
  `, gps_lat, gps_long);
}


// Proximity matching using haversine formula for accurate distance calculation
// First filters by coordinate bounds (~10m) for performance, then calculates exact distance
export async function findProximityGeoMatch(gps_lat, gps_long) {
  return await asyncGet(`
    SELECT uuid, geonames_rev_address_json
    FROM metadata 
    WHERE geonames_rev_address_json IS NOT NULL
    AND ABS(gps_lat - ?) < 0.00009
    AND ABS(gps_long - ?) < 0.00009
    AND 6371000 * 2 * ASIN(
      SQRT(
        POWER(SIN(RADIANS(? - gps_lat) / 2), 2) +
        COS(RADIANS(gps_lat)) * COS(RADIANS(?)) *
        POWER(SIN(RADIANS(? - gps_long) / 2), 2)
      )
    ) < 10
    LIMIT 1
  `, gps_lat, gps_long, gps_lat, gps_lat, gps_long);
}

export async function updateGeoAddress(uuid, geo_address, status = 'FOUND_DB_EXACT_MATCH', matched_uuid = null) {
  return await asyncRun(`UPDATE metadata SET geo_address = ?, geonames_encoding_status = ?, geonames_db_matched_uuid = ? WHERE uuid = ?`, geo_address, status, matched_uuid, uuid);
}

export async function updateGeonamesData(uuid, geonames_json, geo_address) {
  return await asyncRun(`UPDATE metadata SET geonames_rev_address_json = ?, geo_address = ?, geonames_encoding_status = ? WHERE uuid = ?`, geonames_json, geo_address, 'FOUND_VIA_API', uuid);
}

export async function updateGeoEncodingStatus(uuid, status) {
  return await asyncRun(`UPDATE metadata SET geonames_encoding_status = ? WHERE uuid = ?`, status, uuid);
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