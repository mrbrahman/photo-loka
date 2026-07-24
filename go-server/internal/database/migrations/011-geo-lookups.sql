CREATE TABLE IF NOT EXISTS geo_lookups (
  uuid TEXT NOT NULL,
  source TEXT NOT NULL,
  method TEXT NOT NULL,
  matched_uuid TEXT,
  response_json TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (uuid, source)
);
