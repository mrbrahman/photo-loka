-- =============================================================================
-- 002-fts-split.sql - Migrate metadata from FTS5 table to regular table + 2 FTS indexes
--
-- Prerequisites: existing metadata table is the old FTS5 virtual table.
--
-- Steps:
--   1. Rename old metadata FTS table to metadata_backup
--   2. Create new metadata as a regular table
--   3. Create FTS tables, triggers, view
--   4. Migrate data (triggers auto-populate FTS indexes)
--
-- Naming conventions:
--   _date   = date only (YYYY-MM-DD)
--   _at     = datetime/timestamp
--   is_     = boolean (INTEGER 0/1)
--   _json   = JSON text blob
-- =============================================================================

.echo on

-- ---------------------------------------------------------------------------
-- Step 1: Rename old metadata FTS table
-- ---------------------------------------------------------------------------
-- create table metadata_backup_20260618_v9 as select * from metadata;

-- ---------------------------------------------------------------------------
-- Step 2: Create new metadata content table
-- ---------------------------------------------------------------------------
CREATE TABLE metadata (
  id INTEGER PRIMARY KEY,
  collection_id INTEGER,
  uuid TEXT UNIQUE NOT NULL,

  -- album fields
  album_date TEXT,                -- date only: YYYY-MM-DD
  album_name TEXT,                -- human-readable album name

  -- file info
  filename TEXT,
  filesize INTEGER,
  ext TEXT,
  mimetype TEXT,
  mediatype TEXT,

  -- descriptive / searchable
  description TEXT,
  keywords TEXT,
  xmpregion TEXT,
  faces TEXT,
  rating INTEGER,

  -- camera
  make TEXT,
  model TEXT,
  orientation INTEGER,
  duration REAL,

  -- dimensions
  image_width INTEGER,
  image_height INTEGER,
  aspectratio REAL,

  -- GPS
  gps_lat REAL,
  gps_lng REAL,
  gps_alt REAL,
  exiftool_geo_json TEXT,        -- exiftool's built-in geolocation data
  geonames_json TEXT,            -- geonames API reverse geocode response
  geo_status TEXT,               -- encoding status (QUEUED_FOR_API, FOUND_VIA_API, etc.)
  geo_matched_uuid TEXT,         -- uuid of the DB row used for proximity/exact match
  geo_address TEXT,
  geo_city TEXT,                  -- city/placename (best effort, null for remote/rural)
  geo_region TEXT,                -- state/province/adminName1 (best effort, meaning varies by country)
  geo_country TEXT,               -- full country name (from exiftool GeolocationCountry)
  geo_country_code TEXT,          -- ISO 3166-1 alpha-2 (always available if GPS coords exist)

  -- dates
  captured_at TEXT,               -- best resolved capture datetime
  file_modified_at TEXT,          -- filesystem mtime
  exif_datetime_original_ref TEXT, -- raw EXIF DateTimeOriginal (temporary, will be dropped once timezone issues resolved)
  exif_create_date_ref TEXT,      -- raw EXIF CreateDate (temporary, will be dropped once timezone issues resolved)

  -- status
  is_trashed INTEGER DEFAULT 0,
  trashed_at TEXT,
  is_private INTEGER DEFAULT 0,

  -- housekeeping
  indexed_at TEXT,
  updated_at TEXT
);

-- Indexes
CREATE INDEX idx_metadata_coll_capture ON metadata(collection_id, captured_at);
CREATE INDEX idx_metadata_album_date ON metadata(album_date);

-- ---------------------------------------------------------------------------
-- Step 3: FTS tables
-- ---------------------------------------------------------------------------
CREATE VIRTUAL TABLE metadata_fts_porter USING fts5(
  album_name,
  description,
  keywords,
  content='metadata',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE VIRTUAL TABLE metadata_fts_unicode USING fts5(
  filename,
  mimetype,
  mediatype,
  faces,
  make,
  model,
  geo_address,
  album_date,
  content='metadata',
  content_rowid='id',
  tokenize='unicode61'
);

-- ---------------------------------------------------------------------------
-- Step 4: Triggers
-- ---------------------------------------------------------------------------
CREATE TRIGGER metadata_ai AFTER INSERT ON metadata BEGIN
  INSERT INTO metadata_fts_porter(rowid, album_name, description, keywords)
    VALUES (new.id, new.album_name, new.description, new.keywords);
  INSERT INTO metadata_fts_unicode(rowid, filename, mimetype, mediatype, faces, make, model, geo_address, album_date)
    VALUES (new.id, new.filename, new.mimetype, new.mediatype, new.faces, new.make, new.model, new.geo_address, new.album_date);
END;

CREATE TRIGGER metadata_ad AFTER DELETE ON metadata BEGIN
  INSERT INTO metadata_fts_porter(metadata_fts_porter, rowid, album_name, description, keywords)
    VALUES ('delete', old.id, old.album_name, old.description, old.keywords);
  INSERT INTO metadata_fts_unicode(metadata_fts_unicode, rowid, filename, mimetype, mediatype, faces, make, model, geo_address, album_date)
    VALUES ('delete', old.id, old.filename, old.mimetype, old.mediatype, old.faces, old.make, old.model, old.geo_address, old.album_date);
END;

CREATE TRIGGER metadata_au AFTER UPDATE ON metadata BEGIN
  INSERT INTO metadata_fts_porter(metadata_fts_porter, rowid, album_name, description, keywords)
    VALUES ('delete', old.id, old.album_name, old.description, old.keywords);
  INSERT INTO metadata_fts_porter(rowid, album_name, description, keywords)
    VALUES (new.id, new.album_name, new.description, new.keywords);
  INSERT INTO metadata_fts_unicode(metadata_fts_unicode, rowid, filename, mimetype, mediatype, faces, make, model, geo_address, album_date)
    VALUES ('delete', old.id, old.filename, old.mimetype, old.mediatype, old.faces, old.make, old.model, old.geo_address, old.album_date);
  INSERT INTO metadata_fts_unicode(rowid, filename, mimetype, mediatype, faces, make, model, geo_address, album_date)
    VALUES (new.id, new.filename, new.mimetype, new.mediatype, new.faces, new.make, new.model, new.geo_address, new.album_date);
END;

-- ---------------------------------------------------------------------------
-- Step 5: Data migration from backup
--    Column mapping: old name -> new name
--    Triggers auto-populate both FTS tables on INSERT.
-- ---------------------------------------------------------------------------
INSERT INTO metadata (
  collection_id, uuid,
  album_date, album_name,
  filename, filesize, ext, mimetype, mediatype,
  description, keywords, xmpregion, faces, rating,
  make, model, orientation, duration,
  image_width, image_height, aspectratio,
  gps_lat, gps_lng, gps_alt,
  exiftool_geo_json, geonames_json,
  geo_status, geo_matched_uuid,
  geo_address,
  captured_at, file_modified_at,
  exif_datetime_original_ref, exif_create_date_ref,
  is_trashed, trashed_at, is_private,
  indexed_at, updated_at
)
SELECT
  collection_id, uuid,
  album_date, album_name,
  filename, filesize, ext, mimetype, mediatype,
  description, keywords, xmpregion, faces, rating,
  make, model, orientation, duration,
  image_width, image_height, aspectratio,
  gps_lat, gps_long, gps_alt,
  geolocation_api_json, geonames_rev_address_json,
  geonames_encoding_status, geonames_db_matched_uuid,
  geo_address,
  capture_time, file_modify_date,
  datetime_original, create_date,
  trashed, trashed_dt, private,
  indexed_dt, updated_dt
FROM metadata_backup_20260618_v9;

-- ---------------------------------------------------------------------------
-- Step 7: Set schema version
-- ---------------------------------------------------------------------------
PRAGMA user_version = 1;
