import * as fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

import {config} from '../config.mjs';

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
  console.log("creating database ... ");

  // collections table
  var stmt = db.prepare(`
    create table collections (
      collection_id integer PRIMARY KEY AUTOINCREMENT,
      default_collection integer,
      collection_name text,
      collection_path text NOT NULL UNIQUE,
      album_type text,
      listen_paths text,        -- stored as an array (JSON)
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
      keywords, xmpregion, faces, objects, rating UNINDEXED, imagesize UNINDEXED, aspectratio UNINDEXED,
      make, model, orientation UNINDEXED, gps_lat UNINDEXED, gps_long UNINDEXED, gps_alt UNINDEXED, duration UNINDEXED,
      datetime_original UNINDEXED, create_date UNINDEXED, file_modify_date UNINDEXED, file_date UNINDEXED,
      trashed, trashed_dt
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
      action string,
      path1 string,
      path2 string,
      action_tm date DEFAULT (datetime('now','localtime','subsecond'))
    );
  `)
  var info = stmt.run();
}
