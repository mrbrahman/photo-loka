-- =============================================================================
-- EXPERIMENT: Split metadata FTS table into regular table + 2 external content FTS tables
--
-- This creates tables with _v2 suffix for testing alongside existing schema.
-- Once validated, the real migration will use the actual table names.
--
-- Goals:
--   1. metadata_v2: regular table (content table)
--   2. metadata_v2_fts_porter: FTS5 with porter tokenizer for NLP columns
--      (album_name, description, keywords)
--   3. metadata_v2_fts_unicode: FTS5 with unicode61 tokenizer for exact-token columns
--      (filename, mimetype, mediatype, faces, make, model, geo_address)
--   4. Date columns get regular B-tree indexes (no FTS)
--   5. Triggers keep FTS tables in sync with the content table
--   6. View exposes two MATCH handles for searching
--
-- Dropped from old schema: album (superseded by album_date+album_name),
--                          xmpregion, objects (unused)
--
-- Run in a test environment. This is a standalone DDL script.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Content table (regular table)
-- ---------------------------------------------------------------------------
CREATE TABLE metadata_v2 (
  id INTEGER PRIMARY KEY,
  collection_id INTEGER,
  uuid TEXT UNIQUE NOT NULL,

  -- album fields
  album_date TEXT,                -- e.g. '2025-06-15'
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
  gps_long REAL,
  gps_alt REAL,
  geolocation_api_json TEXT,
  geonames_rev_address_json TEXT,
  geonames_encoding_status TEXT,
  geonames_db_matched_uuid TEXT,
  geo_address TEXT,
  geo_city TEXT,                  -- city/placename (best effort, null for remote/rural)
  geo_region TEXT,                -- state/province/adminName1 (best effort, meaning varies by country)
  geo_country TEXT,               -- full country name (from exiftool GeolocationCountry)
  geo_country_code TEXT,          -- ISO 3166-1 alpha-2 (always available if GPS coords exist)

  -- dates
  datetime_original TEXT,
  create_date TEXT,
  file_modify_date TEXT,
  file_date TEXT,
  capture_time TEXT,

  -- status
  trashed INTEGER DEFAULT 0,     -- boolean: 0 or 1
  trashed_dt TEXT,
  private INTEGER DEFAULT 0,     -- boolean: 0 or 1

  -- housekeeping
  indexed_dt TEXT,
  updated_dt TEXT
);

-- ---------------------------------------------------------------------------
-- 2. Indexes on the content table
-- ---------------------------------------------------------------------------
-- Composite: covers "filter by collection" and "filter by collection + sort by date"
CREATE INDEX idx_metadata_v2_coll_capture ON metadata_v2(collection_id, capture_time);
CREATE INDEX idx_metadata_v2_album_date ON metadata_v2(album_date);

-- ---------------------------------------------------------------------------
-- 3. FTS table: Porter tokenizer (NLP / stemming)
--    Columns: album_name, description, keywords
-- ---------------------------------------------------------------------------
CREATE VIRTUAL TABLE metadata_v2_fts_porter USING fts5(
  album_name,
  description,
  keywords,
  content='metadata_v2',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- ---------------------------------------------------------------------------
-- 4. FTS table: Unicode61 tokenizer (exact token match)
--    Columns: filename, mimetype, mediatype, faces, make, model, geo_address
-- ---------------------------------------------------------------------------
CREATE VIRTUAL TABLE metadata_v2_fts_unicode USING fts5(
  filename,
  mimetype,
  mediatype,
  faces,
  make,
  model,
  geo_address,
  content='metadata_v2',
  content_rowid='id',
  tokenize='unicode61'
);

-- ---------------------------------------------------------------------------
-- 5. Triggers to keep FTS tables in sync
-- ---------------------------------------------------------------------------

-- AFTER INSERT: add to both FTS tables
CREATE TRIGGER metadata_v2_ai AFTER INSERT ON metadata_v2 BEGIN
  INSERT INTO metadata_v2_fts_porter(rowid, album_name, description, keywords)
    VALUES (new.id, new.album_name, new.description, new.keywords);
  INSERT INTO metadata_v2_fts_unicode(rowid, filename, mimetype, mediatype, faces, make, model, geo_address)
    VALUES (new.id, new.filename, new.mimetype, new.mediatype, new.faces, new.make, new.model, new.geo_address);
END;

-- AFTER DELETE: remove from both FTS tables
CREATE TRIGGER metadata_v2_ad AFTER DELETE ON metadata_v2 BEGIN
  INSERT INTO metadata_v2_fts_porter(metadata_v2_fts_porter, rowid, album_name, description, keywords)
    VALUES ('delete', old.id, old.album_name, old.description, old.keywords);
  INSERT INTO metadata_v2_fts_unicode(metadata_v2_fts_unicode, rowid, filename, mimetype, mediatype, faces, make, model, geo_address)
    VALUES ('delete', old.id, old.filename, old.mimetype, old.mediatype, old.faces, old.make, old.model, old.geo_address);
END;

-- AFTER UPDATE: remove old, insert new for both FTS tables
CREATE TRIGGER metadata_v2_au AFTER UPDATE ON metadata_v2 BEGIN
  INSERT INTO metadata_v2_fts_porter(metadata_v2_fts_porter, rowid, album_name, description, keywords)
    VALUES ('delete', old.id, old.album_name, old.description, old.keywords);
  INSERT INTO metadata_v2_fts_porter(rowid, album_name, description, keywords)
    VALUES (new.id, new.album_name, new.description, new.keywords);
  INSERT INTO metadata_v2_fts_unicode(metadata_v2_fts_unicode, rowid, filename, mimetype, mediatype, faces, make, model, geo_address)
    VALUES ('delete', old.id, old.filename, old.mimetype, old.mediatype, old.faces, old.make, old.model, old.geo_address);
  INSERT INTO metadata_v2_fts_unicode(rowid, filename, mimetype, mediatype, faces, make, model, geo_address)
    VALUES (new.id, new.filename, new.mimetype, new.mediatype, new.faces, new.make, new.model, new.geo_address);
END;

-- ---------------------------------------------------------------------------
-- 6. Search view
--    Exposes two MATCH handles:
--      search_text_cols  -> porter FTS (album_name, description, keywords)
--      search_meta_cols  -> unicode FTS (filename, mimetype, mediatype, faces, make, model, geo_address)
--
--    Usage:
--      SELECT * FROM metadata_v2_search WHERE search_text_cols MATCH 'sunset';
--      SELECT * FROM metadata_v2_search WHERE search_meta_cols MATCH '{geo_address} : Hawaii';
--      SELECT * FROM metadata_v2_search WHERE search_text_cols MATCH 'vacation' AND search_meta_cols MATCH 'Canon';
-- ---------------------------------------------------------------------------
CREATE VIEW metadata_v2_search AS
SELECT
  m.*,
  p.metadata_v2_fts_porter AS search_text_cols,
  u.metadata_v2_fts_unicode AS search_meta_cols
FROM metadata_v2 m
INNER JOIN metadata_v2_fts_porter p ON p.rowid = m.id
INNER JOIN metadata_v2_fts_unicode u ON u.rowid = m.id;

-- ---------------------------------------------------------------------------
-- 7. Data migration (from existing metadata FTS table)
--    Triggers will auto-populate both FTS tables on INSERT.
-- ---------------------------------------------------------------------------
-- INSERT INTO metadata_v2 (
--   collection_id, uuid,
--   album_date, album_name,
--   filename, filesize, ext, mimetype, mediatype,
--   description, keywords, faces, rating,
--   make, model, orientation, duration,
--   image_width, image_height, aspectratio,
--   gps_lat, gps_long, gps_alt,
--   geolocation_api_json, geonames_rev_address_json,
--   geonames_encoding_status, geonames_db_matched_uuid,
--   geo_address,
--   datetime_original, create_date, file_modify_date, file_date, capture_time,
--   trashed, trashed_dt, private,
--   indexed_dt, updated_dt
-- )
-- SELECT
--   collection_id, uuid,
--   album_date, album_name,
--   filename, filesize, ext, mimetype, mediatype,
--   description, keywords, faces, rating,
--   make, model, orientation, duration,
--   image_width, image_height, aspectratio,
--   gps_lat, gps_long, gps_alt,
--   geolocation_api_json, geonames_rev_address_json,
--   geonames_encoding_status, geonames_db_matched_uuid,
--   geo_address,
--   datetime_original, create_date, file_modify_date, file_date, capture_time,
--   trashed, trashed_dt, private,
--   indexed_dt, updated_dt
-- FROM metadata;
