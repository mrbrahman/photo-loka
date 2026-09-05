CREATE TABLE collections (
  collection_id INTEGER PRIMARY KEY AUTOINCREMENT,
  default_collection INTEGER,
  collection_name TEXT,
  collection_path TEXT NOT NULL UNIQUE,
  album_type TEXT,
  intake_configs TEXT,
  apply_folder_pattern TEXT,
  trash_days INTEGER DEFAULT 30,
  compress_videos INTEGER,
  placeholder_album_text TEXT DEFAULT 'TBD',
  CHECK (album_type IN ('FOLDER_ALBUM', 'VIRTUAL_ALBUM'))
);

CREATE TABLE metadata (
  id INTEGER PRIMARY KEY,
  collection_id INTEGER,
  uuid TEXT UNIQUE NOT NULL,
  album_date TEXT,
  album_name TEXT,
  filename TEXT,
  filesize INTEGER,
  ext TEXT,
  mimetype TEXT,
  mediatype TEXT,
  description TEXT,
  keywords TEXT,
  xmpregion TEXT,
  faces TEXT,
  rating INTEGER,
  make TEXT,
  model TEXT,
  orientation INTEGER,
  duration REAL,
  image_width INTEGER,
  image_height INTEGER,
  aspectratio REAL,
  gps_lat REAL,
  gps_lng REAL,
  gps_alt REAL,
  exiftool_geo_json TEXT,
  geonames_json TEXT,
  geo_status TEXT,
  geo_matched_uuid TEXT,
  geo_address TEXT,
  geo_city TEXT,
  geo_region TEXT,
  geo_country TEXT,
  geo_country_code TEXT,
  captured_at TEXT,
  file_modified_at TEXT,
  exif_datetime_original_ref TEXT,
  exif_create_date_ref TEXT,
  is_trashed INTEGER DEFAULT 0,
  trashed_at TEXT,
  is_private INTEGER DEFAULT 0,
  indexed_at TEXT,
  updated_at TEXT
);

CREATE INDEX idx_metadata_coll_capture ON metadata(collection_id, captured_at);
CREATE INDEX idx_metadata_album_date ON metadata(album_date);

CREATE VIRTUAL TABLE metadata_fts_porter USING fts5(
  album_name, description, keywords,
  content='metadata', content_rowid='id',
  tokenize='porter unicode61'
);

CREATE VIRTUAL TABLE metadata_fts_unicode USING fts5(
  filename, mimetype, mediatype, faces, make, model, geo_address, album_date,
  content='metadata', content_rowid='id',
  tokenize='unicode61'
);

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

CREATE TABLE exif_updates (
  uuid TEXT,
  new_exif_json TEXT,
  update_tm TEXT DEFAULT (datetime('now','localtime')),
  update_status TEXT DEFAULT 'P'
);

CREATE TABLE file_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collection_id INTEGER,
  action TEXT,
  path1 TEXT,
  path2 TEXT,
  action_tm TEXT DEFAULT (datetime('now','localtime','subsecond'))
);

CREATE TABLE backup_status (
  device_id TEXT,
  device_name TEXT,
  device_desc TEXT,
  collection_id INTEGER,
  backup_path TEXT,
  last_backup_status TEXT,
  last_backup_id TEXT
);

CREATE TABLE frames (
  frame_id INTEGER PRIMARY KEY AUTOINCREMENT,
  frame_ip_addr TEXT UNIQUE NOT NULL,
  frame_name TEXT NOT NULL,
  collection_id INTEGER,
  search_str TEXT NOT NULL,
  display_order TEXT,
  daily_pause_range TEXT,
  reset_schedule TEXT
);

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

CREATE TABLE face_recognition (
  uuid TEXT NOT NULL,
  face_idx INTEGER NOT NULL,
  person_name TEXT,
  gender TEXT,
  age INTEGER,
  confidence REAL,
  bbox TEXT,
  landmarks TEXT,
  pose TEXT,
  cluster_id TEXT,
  cluster_name TEXT,
  cluster_confidence REAL,
  cluster_consensus_count INTEGER,
  cluster_reference_image_ids TEXT,
  cluster_is_new INTEGER,
  cluster_centroid TEXT,
  input_face_matched INTEGER,
  input_face_name TEXT,
  input_face_confidence REAL,
  input_face_match_strategy TEXT,
  input_face_bbox TEXT,
  input_face_centroid TEXT,
  name_mismatch INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (uuid, face_idx)
);

CREATE INDEX idx_face_recog_person ON face_recognition(person_name);
CREATE INDEX idx_face_recog_cluster ON face_recognition(cluster_id);

CREATE TABLE face_recognition_unmatched (
  uuid TEXT NOT NULL,
  face_idx INTEGER NOT NULL,
  name TEXT,
  x REAL,
  y REAL,
  w REAL,
  h REAL,
  centroid TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (uuid, face_idx)
);

CREATE TABLE face_dismissed_clusters (
  cluster_id TEXT PRIMARY KEY,
  dismissed_at TEXT DEFAULT (datetime('now','localtime'))
);
