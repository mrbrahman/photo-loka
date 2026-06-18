-- =============================================================================
-- 001-schema.sql - Consolidated fresh install schema
--
-- All tables, indexes, triggers, and views for a fresh database.
-- Replaces all prior migrations (v1 through v8).
--
-- Naming conventions:
--   _date   = date only (YYYY-MM-DD)
--   _at     = datetime/timestamp
--   is_     = boolean (INTEGER 0/1)
--   _json   = JSON text blob
--   _ref    = raw reference value kept temporarily for debugging/migration;
--             intended to be dropped once its purpose is resolved
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Collections
-- ---------------------------------------------------------------------------
CREATE TABLE collections (
  collection_id INTEGER PRIMARY KEY AUTOINCREMENT,
  default_collection INTEGER,
  collection_name TEXT,
  collection_path TEXT NOT NULL UNIQUE,
  album_type TEXT,
  intake_configs TEXT,            -- JSON array of objects with path, method, config
  apply_folder_pattern TEXT,      -- moustache-style format string with tokens
                                  -- {{yyyy}}, {{mm}}, {{dd}} (and optional {{album}}
                                  -- which must be the last token). Used by the
                                  -- pattern engine in #utils/folder-pattern.mjs
                                  -- to format/parse on-disk folder paths.
  trash_days INTEGER DEFAULT 30,
  compress_videos INTEGER,        -- 1 = compress, 0 or null = do not compress
  placeholder_album_text TEXT DEFAULT 'TBD',

  CHECK (album_type IN ('FOLDER_ALBUM', 'VIRTUAL_ALBUM'))
);

-- ---------------------------------------------------------------------------
-- Metadata (content table - regular table)
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

-- Metadata indexes
CREATE INDEX idx_metadata_coll_capture ON metadata(collection_id, captured_at);
CREATE INDEX idx_metadata_album_date ON metadata(album_date);

-- ---------------------------------------------------------------------------
-- Metadata FTS: Porter tokenizer (stemmed / NLP search)
-- Columns: album_name, description, keywords
-- ---------------------------------------------------------------------------
CREATE VIRTUAL TABLE metadata_fts_porter USING fts5(
  album_name,
  description,
  keywords,
  content='metadata',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- ---------------------------------------------------------------------------
-- Metadata FTS: Unicode61 tokenizer (exact token match)
-- Columns: filename, mimetype, mediatype, faces, make, model, geo_address, album_date
-- ---------------------------------------------------------------------------
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
-- Metadata FTS triggers (keep both FTS tables in sync with content table)
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
-- Exif updates queue
-- ---------------------------------------------------------------------------
CREATE TABLE exif_updates (
  uuid TEXT,
  new_exif_json TEXT,
  update_tm TEXT DEFAULT (datetime('now','localtime')),
  update_status TEXT DEFAULT 'P'
);

-- ---------------------------------------------------------------------------
-- File audit log
-- ---------------------------------------------------------------------------
CREATE TABLE file_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collection_id INTEGER,
  action TEXT,
  path1 TEXT,
  path2 TEXT,
  action_tm TEXT DEFAULT (datetime('now','localtime','subsecond'))
);

-- ---------------------------------------------------------------------------
-- Backup status
-- ---------------------------------------------------------------------------
CREATE TABLE backup_status (
  device_id TEXT,
  device_name TEXT,
  device_desc TEXT,
  collection_id INTEGER,
  backup_path TEXT,
  last_backup_status TEXT,
  last_backup_id TEXT
);

-- ---------------------------------------------------------------------------
-- Frames (digital photo frame)
-- ---------------------------------------------------------------------------
CREATE TABLE frames (
  frame_id INTEGER PRIMARY KEY AUTOINCREMENT,
  frame_ip_addr TEXT UNIQUE NOT NULL,
  frame_name TEXT NOT NULL,
  collection_id INTEGER,           -- null = show across collections
  search_str TEXT NOT NULL,        -- valid search input
  display_order TEXT,              -- (date) ASC, (date) DESC, RANDOM
  daily_pause_range TEXT,          -- "HH:mm-HH:mm" in 24hr format
  reset_schedule TEXT              -- crontab format
);

-- ---------------------------------------------------------------------------
-- Authentication
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  user_id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  failed_login_attempts INTEGER DEFAULT 0,
  locked_at TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  CHECK (role IN ('admin', 'user'))
);

CREATE TABLE refresh_tokens (
  token_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash);
CREATE INDEX idx_refresh_tokens_expires ON refresh_tokens(expires_at);

-- ---------------------------------------------------------------------------
-- Face recognition
-- ---------------------------------------------------------------------------
CREATE TABLE face_recognition (
  uuid TEXT NOT NULL,                       -- links to metadata table
  face_idx INTEGER NOT NULL,                -- 0-based index of face within the image
  person_name TEXT,                         -- final resolved name (input_name || cluster_name)
  gender TEXT,                              -- M/F
  age INTEGER,
  confidence REAL,                          -- face detection confidence (0-1)
  bbox TEXT,                                -- JSON [x1,y1,x2,y2] pixel coords
  landmarks TEXT,                           -- JSON {left_eye, right_eye, nose, left_mouth, right_mouth}
  pose TEXT,                                -- JSON {pitch, yaw, roll}
  cluster_id TEXT,                          -- unique cluster ID from ML service
  cluster_name TEXT,                        -- name assigned to this cluster (if any)
  cluster_confidence REAL,                  -- match confidence to existing cluster
  cluster_consensus_count INTEGER,          -- how many existing faces agreed on match
  cluster_reference_image_ids TEXT,         -- JSON array of image IDs of matched faces in cluster
  cluster_is_new INTEGER,                   -- 1 if this face started a new cluster
  cluster_centroid TEXT,                    -- JSON [x, y] normalized centroid of face in image
  input_face_matched INTEGER,               -- 1 if detected face matched an XMP region
  input_face_name TEXT,                     -- name from XMP region
  input_face_confidence REAL,               -- centroid distance match confidence
  input_face_match_strategy TEXT,           -- e.g. 'centroid_distance'
  input_face_bbox TEXT,                     -- JSON [x1,y1,x2,y2] original XMP region in pixels
  input_face_centroid TEXT,                 -- JSON [x, y] original XMP centroid (normalized)
  name_mismatch INTEGER,                    -- 1 if cluster name differs from XMP input name
  created_at TEXT DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (uuid, face_idx)
);

CREATE INDEX idx_face_recog_person ON face_recognition(person_name);
CREATE INDEX idx_face_recog_cluster ON face_recognition(cluster_id);

CREATE TABLE face_recognition_unmatched (
  uuid TEXT NOT NULL,                       -- links to metadata table
  face_idx INTEGER NOT NULL,                -- 0-based index within unmatched list
  name TEXT,                                -- name from XMP region that couldn't be matched
  x REAL,                                   -- normalized x coordinate
  y REAL,                                   -- normalized y coordinate
  w REAL,                                   -- normalized width
  h REAL,                                   -- normalized height
  centroid TEXT,                             -- JSON [x, y] normalized centroid
  created_at TEXT DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (uuid, face_idx)
);

CREATE TABLE face_dismissed_clusters (
  cluster_id TEXT PRIMARY KEY,              -- dismissed at cluster level, hides across all images
  dismissed_at TEXT DEFAULT (datetime('now','localtime'))
);
