.echo on
.timer on

-- =============================================================================
-- 011-backfill-geo-lookups.sql
--
-- One-time data migration: populates geo_lookups from existing metadata JSON
-- columns and backfills geo_ fields on metadata.
--
-- Run via sqlite3 CLI:
--   sqlite3 /path/to/MEMORIES-DATABASE.sqlite < scripts/011-backfill-geo-lookups.sql
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Backfill: migrate existing geonames_json from metadata into geo_lookups
-- ---------------------------------------------------------------------------
INSERT INTO geo_lookups (uuid, source, api_name, request_params, response_json, fetched_at)
  SELECT uuid, 'geonames', 'findNearestAddress',
    json_object('lat', gps_lat, 'lng', gps_lng),
    geonames_json, COALESCE(updated_at, indexed_at, datetime('now','localtime'))
  FROM metadata
  WHERE geonames_json IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Backfill: migrate existing exiftool_geo_json from metadata into geo_lookups
-- ---------------------------------------------------------------------------
INSERT INTO geo_lookups (uuid, source, api_name, request_params, response_json, fetched_at)
  SELECT uuid, 'exiftool', 'geolocation', NULL, exiftool_geo_json, COALESCE(indexed_at, datetime('now','localtime'))
  FROM metadata
  WHERE exiftool_geo_json IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Backfill: populate geo_ fields on metadata from existing JSON data
-- ---------------------------------------------------------------------------

-- For US items that have geonames data: derive city, region, country_code from
-- the findNearestAddress response. City comes from address.placename (may be
-- empty -- postalCodeLookup will fix those via 011-backfill-geo-city.mjs).
UPDATE metadata
SET
  geo_city = NULLIF(json_extract(geonames_json, '$.address.placename'), ''),
  geo_region = json_extract(geonames_json, '$.address.adminName1'),
  geo_country_code = json_extract(geonames_json, '$.address.countryCode')
WHERE geonames_json IS NOT NULL;

-- For non-US items (no geonames data): derive from exiftool geolocation
UPDATE metadata
SET
  geo_city = json_extract(exiftool_geo_json, '$.GeolocationCity'),
  geo_region = json_extract(exiftool_geo_json, '$.GeolocationRegion'),
  geo_country = json_extract(exiftool_geo_json, '$.GeolocationCountry'),
  geo_country_code = json_extract(exiftool_geo_json, '$.GeolocationCountryCode')
WHERE geonames_json IS NULL
  AND exiftool_geo_json IS NOT NULL;

-- For US items with geonames, fill geo_country from exiftool (geonames
-- findNearestAddress does not return the full country name)
UPDATE metadata
SET geo_country = json_extract(exiftool_geo_json, '$.GeolocationCountry')
WHERE geonames_json IS NOT NULL
  AND exiftool_geo_json IS NOT NULL
  AND geo_country IS NULL;
