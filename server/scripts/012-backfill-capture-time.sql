-- Backfill script: populate capture_date, capture_time, capture_tz_offset,
-- and capture_tz_name for all existing rows in the metadata table.
--
-- captured_at format is always rendered by exiftool-vendored with the date
-- at positions 1-10 and time at positions 12-16 (regardless of separator
-- or fractional seconds). The offset location varies by string length.
--
-- SQLite's built-in date/time functions normalize to UTC, so we cannot use
-- them to extract the photographer's local time. Simple substr() works
-- because exiftool-vendored always renders the string in the original
-- capture timezone.
--
-- capture_tz_name is extracted from the geo_lookups table (exiftool source,
-- GeolocationTimeZone field in the response JSON).
--
-- Usage:
--   sqlite3 /path/to/MEMORIES-DATABASE.sqlite < 012-backfill-capture-time.sql
--
-- Safe to re-run: only updates rows where capture_date IS NULL.

UPDATE metadata
SET
  capture_date = substr(captured_at, 1, 10),
  capture_time = substr(captured_at, 12, 8),
  capture_tz_offset = CASE
    WHEN captured_at LIKE '%Z' THEN '+00:00'
    WHEN length(captured_at) = 25 THEN substr(captured_at, 20, 6)
    WHEN length(captured_at) = 29 THEN substr(captured_at, 24, 6)
    ELSE NULL
  END,
  capture_tz_name = (
    SELECT json_extract(gl.response_json, '$.GeolocationTimeZone')
    FROM geo_lookups gl
    WHERE gl.uuid = metadata.uuid
      AND gl.source = 'exiftool'
      AND gl.api_name = 'geolocation'
  )
WHERE (exif_datetime_original_ref is not null OR exif_create_date_ref is not null)
  AND capture_date IS NULL;
