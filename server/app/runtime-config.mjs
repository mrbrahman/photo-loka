import * as fs from 'fs';
import * as path from 'path';
import { startupConfig } from '#startup-config';
import { createLogger } from '#utils/logger';

const logger = createLogger(import.meta.url);

// -------------------------
// Runtime config (JSON file)
// -------------------------
// All tunable config lives in runtime-config.json (inside the data dir).
// This is the single source of truth for both keys and values.
// See runtime-config.example.json for a starter file.
// Changes via the API are written back to this file and take effect immediately.
//
// Design considerations:
//   Considered storing runtime config in a DB table (runtime_config). This would
//   work cleanly now that startup-config.mjs is separate (no circular dependency).
//   Went with JSON for simplicity - native types (no coercion needed unlike DB TEXT
//   columns), no migration needed. Can revisit DB approach later if needed, since
//   the split into startup-config and runtime-config makes it straightforward.
//
// Expected keys in runtime-config.json:
//
//   startFileWatcherAtStartup        (boolean) - start file watcher (immediate indexing) at startup
//   scanFilesForChangesAndIndexAtStartup (boolean) - scan for file changes and index at startup
//   filesDeletedThreshold            (number)  - threshold for number of deleted files before alerting
//
//   startScheduledIndexingAtStartup  (boolean) - start scheduled (cron) indexing at startup
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
//   maxConcurrency                   (number)  - max parallel indexing tasks
//                                                Applied to the indexer queue during startup (in startup-manager.mjs)
//                                                after the queue is already created with a CPU-based default.
//                                                NOTE: changing this via the config API (PUT /api/updateConfig) only
//                                                persists the value - takes effect on next restart. To change concurrency
//                                                immediately at runtime, use PUT /api/updateIndexerConcurrency which
//                                                updates the indexer queue AND persists the value back to this file.
//                                                This is the only key that needs such special handling. All other keys
//                                                are read fresh on each use, so config changes take effect naturally.
//
//   performFaceRecognition           (boolean) - run face recognition during indexing

const runtimeConfigFile = path.join(startupConfig.dataDir, 'runtime-config.json');

if (!fs.existsSync(runtimeConfigFile)) {
  throw new Error(`Runtime config file not found: ${runtimeConfigFile}. Copy runtime-config.example.json to get started.`);
}

const config = JSON.parse(fs.readFileSync(runtimeConfigFile, 'utf-8'));
logger.info(`Loaded runtime config from ${runtimeConfigFile}`);

export function getRuntimeConfig() {
  return config;
}

export function updateRuntimeConfig(key, value) {
  if (!(key in config)) {
    throw new Error(`Unknown runtime config key: '${key}'`);
  }

  config[key] = value;

  // persist all current values to file
  fs.writeFileSync(runtimeConfigFile, JSON.stringify(config, null, 2));
  logger.info(`Runtime config updated: ${key} = ${value}`);
}

export { config };
