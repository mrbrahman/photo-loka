import * as path from 'path';

// -------------------------
// Startup config (env vars)
// -------------------------
// Structural config that is set once via .env and never changes at runtime.
// This module has no app dependencies - it loads before everything else,
// including the DB and logger. Modules that need paths, secrets, or other
// bootstrap values import from here.
//
// For tunable config that can be changed at runtime, see runtime-config.mjs.

const startupConfig = {};

// dirs
startupConfig.dataDir = process.env.DATA_DIR || 'data';
startupConfig.thumbsDir = path.join(startupConfig.dataDir, 'thumbnails');
startupConfig.facesDir = path.join(startupConfig.dataDir, 'faces');

// db file
startupConfig.dbFile = path.join(startupConfig.dataDir, 'MEMORIES-DATABASE.sqlite');

// JWT secret for authentication
if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required');
}
startupConfig.jwtSecret = process.env.JWT_SECRET;

// ML service URL
startupConfig.mlServiceUrl = process.env.ML_SERVICE_URL || 'http://localhost:8000';

// indexer mode: 'static' (fixed concurrency) or 'dynamic' (auto-adjusts based on system load)
// This is structural - determines which queue implementation is created at module load time.
// Cannot be changed at runtime.
startupConfig.indexerMode = process.env.INDEXER_MODE || 'static';

// geonames
startupConfig.geonamesUsername = process.env.GEONAMES_USERNAME;

// logger
startupConfig.logLevel = process.env.LOG_LEVEL || 'info';
startupConfig.noColor = process.env.NO_COLOR === '1';

// node environment
startupConfig.nodeEnv = process.env.NODE_ENV;

export { startupConfig };
