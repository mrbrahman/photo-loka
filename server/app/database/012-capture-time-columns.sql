-- Migration 012: Add capture_date, capture_time, capture_tz_offset,
-- capture_tz_name columns.
--
-- These are derived from captured_at using Temporal and represent the
-- photographer's local date/time/offset at the moment of capture.
-- All are NULL when captured_at is NULL (e.g. WhatsApp images with
-- no EXIF date).
--
-- Why store these separately instead of extracting at query time?
-- SQLite's date/time functions (strftime, time, datetime) always normalize
-- to UTC when the input has a timezone offset. There is no way to extract
-- the photographer's local time or offset from a stored ISO string at
-- query time. Pre-computing at index time is the only option.
--
-- capture_tz_name is the IANA timezone name (e.g. 'America/New_York')
-- inferred by exiftool-vendored from GPS coordinates or explicit EXIF
-- timezone tags. Used by the frontend to derive correct abbreviations
-- (EST, IST, etc.) via Intl.DateTimeFormat.
--
-- album_date remains the organizational grouping date (may differ from
-- capture_date due to folder-based derivation or future 2am-rollover logic).

ALTER TABLE metadata ADD COLUMN capture_date TEXT;
ALTER TABLE metadata ADD COLUMN capture_time TEXT;
ALTER TABLE metadata ADD COLUMN capture_tz_offset TEXT;
ALTER TABLE metadata ADD COLUMN capture_tz_name TEXT;
