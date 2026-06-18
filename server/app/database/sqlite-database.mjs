import * as fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { createLogger } from '#utils/logger';
import { startupConfig } from '#startup-config';

const logger = createLogger(import.meta.url);

// TODO: configure this to run on worker threads (is it needed after PRAGMA statements below?)
// https://github.com/JoshuaWise/better-sqlite3/blob/master/docs/threads.md

const dbFile = startupConfig.dbFile;

if(!fs.existsSync(path.dirname(dbFile))){
  fs.mkdirSync(path.dirname(dbFile), {recursive: true});
}

export const db = new Database(dbFile, {  }); // verbose: console.log
// PRAGMA statements to make sqlite run faster
// found at https://stackoverflow.com/a/27290180/8098748
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("busy_timeout = 5000");

// ---------------------------------------------------------------------------
// Schema installation / migrations (based on user_version)
// ---------------------------------------------------------------------------
const schemaDir = import.meta.dirname;

let currentVersion = db.pragma("user_version", {simple: true});

if (currentVersion < 1) {
  logger.info("Fresh install: creating database schema ...");
  const sql = fs.readFileSync(path.join(schemaDir, '001-initial-schema.sql'), 'utf8');
  db.transaction(() => {
    db.exec(sql);
  })();
  currentVersion = 1;
  db.pragma("user_version = 1");
}

// Future migrations go here:
// if (currentVersion < 2) {
//   logger.info("Running migration 002 ...");
//   const sql = fs.readFileSync(path.join(schemaDir, '002-something.sql'), 'utf8');
//   db.transaction(() => {
//     db.exec(sql);
//   })();
//   currentVersion = 2;
//   db.pragma("user_version = 2");
// }

// ---------------------------------------------------------------------------
// Custom aggregate functions
// ---------------------------------------------------------------------------

// json_patch_agg: aggregate function similar to SQLite's json_patch,
// used for merging all exif updates required on a file in 'exif_updates' table
db.aggregate('json_patch_agg', {
  directOnly: true,
  start: {},
  step: (buf, inp)=>({...buf, ...JSON.parse(inp)}),
  result: out=>JSON.stringify(out)
});
