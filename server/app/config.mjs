import * as fs from 'fs';
import * as path from 'path';

const config = {};

// dirs
config.dataDir = process.env.DATA_DIR || 'data';
config.thumbsDir = path.join(config.dataDir, 'thumbnails');
config.facesDir = path.join(config.dataDir, 'faces');

// db file
config.dbFile = path.join(config.dataDir, 'MEMORIES-DATABASE.sqlite')

// JWT secret for authentication
if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required');
}
config.jwtSecret = process.env.JWT_SECRET;

// ML service URL
config.mlServiceUrl = process.env.ML_SERVICE_URL || 'http://localhost:8000';

// -------------------------
// Runtime config (JSON file)
// -------------------------
// All tunable config lives in runtime-config.json (inside the data dir).
// This is the single source of truth for both keys and values.
// See runtime-config.example.json for a starter file.
// Changes via the API are written back to this file and take effect immediately.
//
// Design considerations:
//   Considered storing runtime config in a DB table (runtime_config). This was
//   cleaner in some ways (one less file, backup comes free with DB), but introduced
//   a circular dependency: sqlite-database.mjs imports config.mjs for the DB path,
//   so config.mjs can't import sqlite-database.mjs to read the config table. This
//   forced a strict import ordering requirement in server.mjs (sqlite-database before
//   services) because some modules (e.g. queue-manager) read config at top-level
//   during module load. Also needed type coercion since SQLite stores everything as TEXT.
//
//   JSON file avoids all of this: read synchronously at module load time in config.mjs
//   (before any other module initializes), native types (no coercion), no migration
//   needed, no import ordering concerns.
//
// Expected keys in runtime-config.json:
//
//   startFileWatcherAtStartup        (boolean) - start file watcher (immediate indexing) at startup
//   scanFilesForChangesAndIndexAtStartup (boolean) - scan for file changes and index at startup
//   filesDeletedThreshold            (number)  - threshold for number of deleted files before alerting
//
//   enableScheduledIndexing          (boolean) - enable scheduled (cron) indexing
//   staleDays                        (number)  - number of days a file must be stale before intake indexing
//
//   performVideoCompression          (boolean) - compress videos during indexing
//
//   auditFiles                       (boolean) - audit file operations for backup sync
//                                                helps if changes (e.g. rename folders, move files)
//                                                needs to be synced to multiple hard drives
//
//   geonamesHourlyLimit              (number)  - geonames API hourly request limit
//   geonamesDailyLimit               (number)  - geonames API daily request limit
//
//   videoEncoder                     (string)  - video encoder for compression
//                                                VP8: 'libvpx' (software)
//                                                VP9: 'libvpx-vp9' (software)
//                                                H.264 Hardware: 'h264_nvenc'(NVIDIA) / 'h264_qsv'(Intel) / 'h264_amf'(AMD)
//                                                H.265/HEVC Hardware: 'hevc_nvenc'(NVIDIA) / 'hevc_qsv'(Intel) / 'hevc_amf'(AMD)
//                                                AV1: 'libaom-av1'(software) / 'av1_nvenc'(NVIDIA RTX40+) / 'av1_qsv'(Intel Arc)
//                                                Container is auto-determined: webm for VP8/VP9, mp4 for H.264/H.265/AV1
//
//   indexerMode                      (string)  - 'static' (fixed concurrency) or 'dynamic' (auto-adjusts based on system load)
//   maxConcurrency                   (number)  - max parallel indexing tasks
//                                                Used as the initial concurrency at startup. If not set, falls back to
//                                                (CPU count - 1).
//                                                NOTE: changing this via the config API (PUT /api/updateConfig) only
//                                                persists the value - takes effect on next restart. To change concurrency
//                                                immediately at runtime, use PUT /api/updateIndexerConcurrency which
//                                                updates the indexer queue AND persists the value back to this file.
//                                                This is the only key that needs such special handling. All other keys
//                                                are read fresh on each use, so config changes take effect naturally.
//
//   performFaceRecognition           (boolean) - run face recognition during indexing

const runtimeConfigFile = path.join(config.dataDir, 'runtime-config.json');

if (!fs.existsSync(runtimeConfigFile)) {
  throw new Error(`Runtime config file not found: ${runtimeConfigFile}. Copy runtime-config.example.json to ${runtimeConfigFile} to get started.`);
}

// NOTE: No logging here (neither logger nor console.log) because:
// - Using the app logger causes a circular dependency (config -> logger -> authn-middleware -> authn-service -> config)
// - Using console.log prints multiple times because db-pool.mjs spawns worker threads,
//   each of which imports #config independently (worker threads have their own module scope)
const runtimeConfig = JSON.parse(fs.readFileSync(runtimeConfigFile, 'utf-8'));
Object.assign(config, runtimeConfig);

export function getRuntimeConfig() {
  return JSON.parse(fs.readFileSync(runtimeConfigFile, 'utf-8'));
}

export function updateRuntimeConfig(key, value) {
  const saved = JSON.parse(fs.readFileSync(runtimeConfigFile, 'utf-8'));
  if (!(key in saved)) {
    throw new Error(`Unknown runtime config key: '${key}'`);
  }

  saved[key] = value;
  fs.writeFileSync(runtimeConfigFile, JSON.stringify(saved, null, 2));

  config[key] = value;
  console.log(`[config.mjs] Runtime config updated: ${key} = ${value}`);
}

export { config };
