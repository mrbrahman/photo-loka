CREATE TABLE geo_lookups (
  id INTEGER PRIMARY KEY,
  uuid TEXT NOT NULL,
  source TEXT NOT NULL,            -- 'exiftool' | 'geonames'
  api_name TEXT NOT NULL,          -- 'geolocation', 'findNearestAddress', 'postalCodeLookup'
  request_params TEXT,             -- JSON, e.g. {"lat":40.73,"lng":-74.32} or {"postalcode":"08902","country":"US"}
  response_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  UNIQUE(uuid, api_name)
);

CREATE INDEX idx_geo_lookups_uuid ON geo_lookups(uuid);
CREATE INDEX idx_geo_lookups_api_name ON geo_lookups(api_name);
