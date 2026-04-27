import * as fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { createLogger } from '#utils/logger';

import {startupConfig} from '#startup-config';

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

// install schema as needed (based on 'user_version')

let currentVersion = db.pragma("user_version", {simple: true});

if(currentVersion < 1){
  initialDbSetup();
  currentVersion = 1;
  db.pragma("user_version = 1");
}

if(currentVersion < 2){
  addAuthenticationTables();
  currentVersion = 2;
  db.pragma("user_version = 2");
}

if(currentVersion < 3){
  addFaceRecognitionTables();
  currentVersion = 3;
  db.pragma("user_version = 3");
}

if(currentVersion < 4){
  addFaceDismissedTable();
  currentVersion = 4;
  db.pragma("user_version = 4");
}

if(currentVersion < 5){
  addPrivateColumn(5);
  currentVersion = 5;
  db.pragma("user_version = 5");
}

// define a json_patch_agg SQL aggregate function, which is similar to the SQLite provided
// json_patch function, however this is an aggregate function
// this is used in merging all exif updates required to be done on a file in 'exif_updates' table
db.aggregate('json_patch_agg', {
  directOnly: true,
  start: {},
  step: (buf, inp)=>({...buf, ...JSON.parse(inp)}),
  result: out=>JSON.stringify(out)
});

function initialDbSetup() {
  logger.info("creating database ... ");

  // collections table
  var stmt = db.prepare(`
    create table collections (
      collection_id integer PRIMARY KEY AUTOINCREMENT,
      default_collection integer,
      collection_name text,
      collection_path text NOT NULL UNIQUE,
      album_type text,
      intake_configs text,      -- stored as an array of objects (JSON) with path, method, config
      apply_folder_pattern,     -- need to be 'dateformat' package compatible format
      trash_days integer DEFAULT 30,

      check (album_type in ('FOLDER_ALBUM', 'VIRTUAL_ALBUM'))
    )
  `);
  var info = stmt.run();

  // metadata table (single record per file)
  // this is an FTS file table, which enables "search" feature
  var stmt = db.prepare(`
    create virtual table metadata using fts5(
      collection_id UNINDEXED, uuid UNINDEXED, album, filename,
      description, filesize UNINDEXED, ext UNINDEXED, mimetype, mediatype,
      keywords, xmpregion, faces, objects, rating UNINDEXED, 
      image_width UNINDEXED, image_height UNINDEXED, aspectratio UNINDEXED,
      make, model, orientation UNINDEXED, duration UNINDEXED,
      gps_lat UNINDEXED, gps_long UNINDEXED, gps_alt UNINDEXED, 
      geolocation_api_json UNINDEXED, 
      geonames_rev_address_json UNINDEXED, geonames_encoding_status UNINDEXED, geonames_db_matched_uuid UNINDEXED,
      geo_address, 
      datetime_original UNINDEXED, create_date UNINDEXED, file_modify_date UNINDEXED, file_date UNINDEXED,
      trashed, trashed_dt,
      indexed_dt, updated_dt
    )
  `);
  var info = stmt.run();

  // object details table (determined through ML etc.)
  var stmt = db.prepare(`
    create table object_details (
      uuid, frame, how_found,
      region_name text, region_type text,
      region_area_x real, region_area_y real,
      region_area_w real, region_area_h real,
      region_area_unit text
    )
  `);
  var info = stmt.run();

  var stmt = db.prepare(`
    create table exif_updates (
      uuid, new_exif_json, 
      update_tm date DEFAULT (datetime('now','localtime')), update_status DEFAULT 'P'
    );
  `);
  var info = stmt.run();

  var stmt = db.prepare(`
    create table file_audit_log (
      id integer PRIMARY KEY AUTOINCREMENT,
      collection_id integer,
      action string,
      path1 string,
      path2 string,
      action_tm date DEFAULT (datetime('now','localtime','subsecond'))
    );
  `)
  var info = stmt.run();

  var stmt = db.prepare(`
    create table backup_status (
      device_id, device_name, device_desc, collection_id, backup_path, 
      last_backup_status, last_backup_id
    );
  `)
  var info = stmt.run();

  var stmt = db.prepare(`
    create table frames (
      frame_id integer PRIMARY KEY AUTOINCREMENT,
      frame_ip_addr varchar UNIQUE not null,
      frame_name varchar not null,
      collection_id integer,        -- collection to search for items to show in frame, null to show across collections
      search_str varchar not null,  -- valid search input
      display_order varchar,        -- (date) ASC, (date) DESC, RANDOM
      daily_pause_range varchar,       -- time range in which frame needs to be paused every day, stored as "HH:mm-HH:mm" in 24 hr format
      -- pause_schedule varchar,       -- crontab format
      -- resume_schedule varchar,      -- crontab format
      reset_schedule varchar        -- crontab format
      
      -- let these 2 be in the app
      -- in case of app restarts, they will be reset, which should be fine

      --items varchar,                -- array of items based on search grabbed as of the time of reset
      --last_idx int,                 -- last index of item being shown in frame
    );
  `)
  var info = stmt.run();
}

function addFaceRecognitionTables() {
  logger.info("adding face recognition tables ... ");

  db.prepare(`
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
      created_tm TEXT DEFAULT (datetime('now','localtime')),
      PRIMARY KEY (uuid, face_idx)
    )
  `).run();

  db.prepare('CREATE INDEX idx_face_recog_person ON face_recognition(person_name)').run();
  db.prepare('CREATE INDEX idx_face_recog_cluster ON face_recognition(cluster_id)').run();

  db.prepare(`
    CREATE TABLE face_recognition_unmatched (
      uuid TEXT NOT NULL,                       -- links to metadata table
      face_idx INTEGER NOT NULL,                -- 0-based index within unmatched list
      name TEXT,                                -- name from XMP region that couldn't be matched
      x REAL,                                   -- normalized x coordinate
      y REAL,                                   -- normalized y coordinate
      w REAL,                                   -- normalized width
      h REAL,                                   -- normalized height
      centroid TEXT,                             -- JSON [x, y] normalized centroid
      created_tm TEXT DEFAULT (datetime('now','localtime')),
      PRIMARY KEY (uuid, face_idx)
    )
  `).run();
}

function addFaceDismissedTable() {
  logger.info("adding face dismissed clusters table ... ");

  db.prepare(`
    CREATE TABLE face_dismissed_clusters (
      cluster_id TEXT PRIMARY KEY,              -- dismissed at cluster level, hides across all images
      dismissed_tm TEXT DEFAULT (datetime('now','localtime'))
    )
  `).run();
}

function addAuthenticationTables() {
  logger.info("adding authentication tables ... ");

  var stmt = db.prepare(`
    create table users (
      user_id integer PRIMARY KEY AUTOINCREMENT,
      username varchar UNIQUE NOT NULL,
      password_hash varchar NOT NULL,
      role varchar NOT NULL DEFAULT 'user',
      failed_login_attempts integer DEFAULT 0,
      locked_at datetime,
      created_at datetime DEFAULT (datetime('now','localtime')),
      check (role in ('admin', 'user'))
    )
  `);
  stmt.run();

  stmt = db.prepare(`
    create table refresh_tokens (
      token_id integer PRIMARY KEY AUTOINCREMENT,
      user_id integer NOT NULL,
      token_hash varchar NOT NULL,
      expires_at datetime NOT NULL,
      created_at datetime DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (user_id) REFERENCES users(user_id)
    )
  `);
  stmt.run();

  db.prepare('CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash)').run();
  db.prepare('CREATE INDEX idx_refresh_tokens_expires ON refresh_tokens(expires_at)').run();
}

function rebuildMetadataTable(version, columnDef, newColumns) {
  let dateSuffix = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  let backupTable = `metadata_backup_${dateSuffix}_v${version}`;

  // 1. backup into a regular table
  db.prepare(`CREATE TABLE ${backupTable} AS SELECT * FROM metadata`).run();

  let origCount = db.prepare(`SELECT COUNT(*) as cnt FROM metadata`).get().cnt;
  let backupCount = db.prepare(`SELECT COUNT(*) as cnt FROM ${backupTable}`).get().cnt;

  // 2. validate backup count
  if (origCount !== backupCount) {
    throw new Error(`Migration v${version} failed: backup count mismatch (original: ${origCount}, backup: ${backupCount}). Backup table ${backupTable} preserved.`);
  }

  // 3. drop old metadata table
  db.prepare(`DROP TABLE metadata`).run();

  // 4. create new metadata table
  db.prepare(`CREATE VIRTUAL TABLE metadata USING fts5(${columnDef})`).run();

  // 5. populate from backup - old columns from backup, null for new columns
  let oldColumns = db.pragma(`table_info(${backupTable})`).map(c => c.name);
  let insertCols = [...oldColumns, ...newColumns].join(', ');
  let selectCols = [...oldColumns, ...newColumns.map(() => 'null')].join(', ');

  db.prepare(`INSERT INTO metadata(${insertCols}) SELECT ${selectCols} FROM ${backupTable}`).run();

  // 6. validate new table count
  let newCount = db.prepare(`SELECT COUNT(*) as cnt FROM metadata`).get().cnt;
  if (backupCount !== newCount) {
    throw new Error(`Migration v${version} failed: new table count mismatch (backup: ${backupCount}, new: ${newCount}). Backup table ${backupTable} preserved.`);
  }

  // 7. backup table kept around for safety - drop manually when confident
  // db.prepare(`DROP TABLE ${backupTable}`).run();

  logger.info(`Migration v${version} complete (${newCount} rows migrated). Backup table: ${backupTable}`);
}

function addPrivateColumn(version) {
  logger.info("adding private column to metadata table ...");
  rebuildMetadataTable(version, `
    collection_id UNINDEXED, uuid UNINDEXED, album, filename,
    description, filesize UNINDEXED, ext UNINDEXED, mimetype, mediatype,
    keywords, xmpregion, faces, objects, rating UNINDEXED,
    image_width UNINDEXED, image_height UNINDEXED, aspectratio UNINDEXED,
    make, model, orientation UNINDEXED, duration UNINDEXED,
    gps_lat UNINDEXED, gps_long UNINDEXED, gps_alt UNINDEXED,
    geolocation_api_json UNINDEXED,
    geonames_rev_address_json UNINDEXED, geonames_encoding_status UNINDEXED, geonames_db_matched_uuid UNINDEXED,
    geo_address,
    datetime_original UNINDEXED, create_date UNINDEXED, file_modify_date UNINDEXED, file_date UNINDEXED,
    trashed, trashed_dt,
    private UNINDEXED,
    indexed_dt, updated_dt
  `, ['private']);
}

