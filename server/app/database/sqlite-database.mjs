import * as fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { createLogger } from '#utils/logger';

import {config} from '#config';

const logger = createLogger(import.meta.url);

// TODO: configure this to run on worker threads (is it needed after PRAGMA statements below?)
// https://github.com/JoshuaWise/better-sqlite3/blob/master/docs/threads.md

const dbFile = config.dbFile;

if(!fs.existsSync(path.dirname(dbFile))){
  fs.mkdirSync(path.dirname(dbFile), {recursive: true});
}

export const db = new Database(dbFile, {  }); // verbose: console.log
// PRAGMA statements to make sqlite run faster
// found at https://stackoverflow.com/a/27290180/8098748
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

// install schema as needed (based on 'user_version')

if(db.pragma("user_version", {simple: true}) < 1){
  initialDbSetup();
  db.pragma("user_version = 1");
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
    );
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
