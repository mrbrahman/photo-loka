import {EventEmitter} from 'events';

import {config} from '../config.mjs'
import { db } from './sqlite-database.mjs';
import {ProcessDataInChunks as chunks} from '../utils/process-data-in-chunks.mjs'

class EmitterClass extends EventEmitter {};
export const dbEvents = new EmitterClass();

dbEvents.on('ran', (_)=>{
  console.log(`DB Update ran. ${_} entries`)
});

const deleteFromMetadataStatement = `
delete from metadata
where uuid = @uuid
`;

const insertIntoMetadataStatement = `
insert into metadata
(
  collection_id, uuid, album, filename,
  description, filesize, ext, mimetype, mediatype,
  keywords, faces, objects, rating, imagesize, aspectratio,
  make, model, orientation, gpsposition, duration,
  region_applied_to_dimension_w, region_applied_to_dimension_h, region_applied_to_dimension_unit,
  datetime_original, create_date, file_modify_date, file_date
)
values
(
  @collection_id, @uuid, @album, @filename,
  @description, @filesize, @ext, @mimetype, @mediatype,
  @keywords, @faces, @objects, @rating, @imagesize, @aspectratio,
  @make, @model, @orientation, @gpsposition, @duration,
  @region_applied_to_dimension_w, @region_applied_to_dimension_h, @region_applied_to_dimension_unit,
  @datetime_original, @create_date, @file_modify_date, @file_date
)
`;

const deleteFromObjectDetailsStatement = `
delete from object_details
where uuid = @uuid
`;

const insertIntoObjectDetailsStatement = `
insert into object_details
(
  uuid, frame, how_found,
  region_name, region_type,
  region_area_x, region_area_y,
  region_area_w, region_area_h,
  region_area_unit
)
values
(
  @uuid, @frame, @how_found,
  @region_name, @region_type,
  @region_area_x, @region_area_y,
  @region_area_w, @region_area_h,
  @region_area_unit
)
`;

const insertIntoExifUpdatesStatement = `
  insert into exif_updates
  (uuid, new_exif_json)
  values
  (@uuid, @new_exif_json)
`;

const updateRatingStatement = `
  update metadata
  set rating = @newRating,
    file_modify_date = @fileModifyDate
  where uuid = @uuid
`;

const updateToTrashStatement = `
  update metadata
  set filename = @trashFilename,
    trashed = 1, trashed_dt = datetime('now','localtime')
  where uuid = @uuid
`;

const getFileNameStatement = `
  select filename 
  from metadata
  where uuid = @uuid
`;

const retriveMetadataStatement = `
  select filename, mediatype -- let's add others as necessary
  from metadata
  where uuid = @uuid
`;

const fileAuditStatement = `
  insert into file_audit_log
  (action, path1, path2)
  values
  (@action, @path1, @path2)
`

const deleteMetadata = db.prepare(deleteFromMetadataStatement);
const insertMetadata = db.prepare(insertIntoMetadataStatement);
const deleteObjectDetails = db.prepare(deleteFromObjectDetailsStatement);
const insertObjectDetails = db.prepare(insertIntoObjectDetailsStatement);
const insertIntoExifUpdates = db.prepare(insertIntoExifUpdatesStatement);
const updateRatingInDb = db.prepare(updateRatingStatement);
const updateToTrashInDb = db.prepare(updateToTrashStatement);
const getFileNameFromDb = db.prepare(getFileNameStatement);
const retriveMetadataFromDb = db.prepare(retriveMetadataStatement);
const fileAuditInDb = db.prepare(fileAuditStatement);

function transformDataToMetadataRow(row){
  ['faces','objects','keywords'].forEach(c=>{
    row[c] = JSON.stringify(row[c])
  });
  return row;
}

async function indexerDbTask(entries){
  let start = performance.now();

  let insertMany = db.transaction(
    function(tasks){
      for (let task of tasks) {
        if(task.action == 'delete'){
          deleteObjectDetails.run(task.data);
          deleteMetadata.run(task.data);
        } else if (task.action == 'insert'){
          // first clean-up any old entries
          // deleteObjectDetails.run(task.data);
          // deleteMetadata.run(task.data);
          
          insertMetadata.run( transformDataToMetadataRow(task.data) );

          if(task.data.parsedFaces){
            // TODO: create transformObjectDetailsToDb? what about uuid?
            task.data.parsedFaces.forEach(o=>insertObjectDetails.run({
              uuid: task.data.uuid,
              frame: '',                    // TODO: future use. may be this will help for video files?
              how_found: task.data.software,    // software that found this
              region_name: o.Name,
              region_type: o.Type,
              region_area_x: o.Area.X,
              region_area_y: o.Area.Y,
              region_area_w: o.Area.W,
              region_area_h: o.Area.H,
              region_area_unit: o.Area.Unit
            }));
          } // parsedFaces
        }
      } // for loop
    } // end of function
  ); // db.transaction

  insertMany(entries);
  console.log(`DB update: Completed ${entries.length} entries in ${performance.now()-start} ms`)
  return entries.length
}

// expose a function to perform db activities in "chunks"
export const indexerDbWriteInChunks = chunks()
  .maxWaitTimeBeforeScoopMS(config.indexerDbUpdateTimeout)
  .maxItemsBeforeScoop(config.indexerDbUpdateChunk)
  .emitter(dbEvents)
  .invokeFunction( (_)=>indexerDbTask(_) )
;

// async function, so it can be run in background
export async function getIndexedFilesModifyTime(collection_id){
  let stmt = db.prepare(`
    select filename, uuid, file_modify_date
    from metadata
    where collection_id = ?
  `);

  let result = stmt.all(collection_id);

  // convert output into hash map
  return result.reduce(function(acc,curr){
    acc[curr.filename]={
      uuid: curr.uuid, 
      mtime: Math.floor( (new Date(curr.file_modify_date).getTime()) / 1000)  // Unix Epoch
    }; 
    return acc;
  }, {})
}

export function updateAlbum(collection_id, fromAlbum, toAlbum, updateFileName){
  let stmt = db.prepare(`
    update metadata
    set album = @toAlbum
      ${updateFileName ? ", filename = replace(filename, @fromAlbum, @toAlbum)" : ''} 
    where collection_id = @collection_id
    and album = @fromAlbum
  `);

  let cnt = stmt.run({collection_id, fromAlbum, toAlbum});
  return cnt;
}

export function updateAlbumForItems(uuid_arr, toAlbum, updateFileName){
  let stmt = db.prepare(`
    update metadata
    set album = @toAlbum
      ${updateFileName ? ", filename = replace(filename, album, @toAlbum)" : ''} 
    where uuid = @uuid
  `);

  let trans = db.transaction(
    function(uuid_arr, toAlbum, updateFileName){
      for (let uuid of uuid_arr){
        stmt.run({uuid, toAlbum, updateFileName});
      }
    }
  )

  trans(uuid_arr, toAlbum, updateFileName);
}


export function getFileName(uuid){
  return getFileNameFromDb.get({uuid}).filename;
}

export function retriveMetadata(uuid){
  return retriveMetadataFromDb.get({uuid});
}

export function updateRating(uuid_arr, newRating, fileModifyDate){

  let trans = db.transaction(
    function(uuid_arr, newRating, fileModifyDate){
      for (let uuid of uuid_arr){
        console.log(`${uuid} ${newRating} ${fileModifyDate}`);
        updateRatingInDb.run({uuid, newRating, fileModifyDate});
      }
    }
  )

  trans(uuid_arr, newRating, fileModifyDate);
}

export function trashItem(uuid, trashFilename){
  console.log(`Updating to trash ${uuid} ${trashFilename}`);
  updateToTrashInDb.run({uuid, trashFilename});
}

export function scheduleExif(uuid_arr, new_exif_json){
  let insertMany = db.transaction(
    function(uuid_arr, new_exif_json){
      for(let uuid of uuid_arr){
        insertIntoExifUpdates.run({uuid, new_exif_json: JSON.stringify(new_exif_json)})
      }
    }
  );

  insertMany(uuid_arr, new_exif_json);
  return uuid_arr.length;
}

export function fileAudit(action, path1, path2=null){
  fileAuditInDb.run({action, path1, path2});
}