import { asyncGet, asyncAll, asyncRun } from '#db/db-pool';
import { db } from '#db/sqlite-database'; // For transaction-based operations
import { createLogger } from '#utils/logger';

const logger = createLogger(import.meta.url);


const deleteFromMetadataStatement = `
delete from metadata
where uuid = @uuid
`;

const insertIntoMetadataStatement = `
insert into metadata
(
  collection_id, uuid, album_date, album_name, filename,
  description, filesize, ext, mimetype, mediatype,
  keywords, xmpregion, faces, rating, 
  image_width, image_height, aspectratio,
  make, model, orientation, duration, 
  gps_lat, gps_lng, gps_alt,
  file_modified_at, captured_at,
  capture_date, capture_time, capture_tz_offset, capture_tz_name,
  exif_datetime_original_ref, exif_create_date_ref,
  indexed_at
)
values
(
  @collection_id, @uuid, @album_date, @album_name, @filename,
  @description, @filesize, @ext, @mimetype, @mediatype,
  @keywords, @xmpregion, @faces, @rating, 
  @image_width, @image_height, @aspectratio,
  @make, @model, @orientation, @duration, 
  @gps_lat, @gps_lng, @gps_alt,
  @file_modified_at, @captured_at,
  @capture_date, @capture_time, @capture_tz_offset, @capture_tz_name,
  @exif_datetime_original_ref, @exif_create_date_ref,
  datetime('now','localtime')
)
`;

const updateMetadataStatement = `
  update metadata
  set
    -- collection_id = @collection_id,
    -- album_date = @album_date,
    -- album_name = @album_name,
    -- filename = @filename,
    description = @description,
    filesize = @filesize,
    ext = @ext,
    mimetype = @mimetype,
    mediatype = @mediatype,
    keywords = @keywords,
    xmpregion = @xmpregion,
    faces = @faces,
    rating = @rating,
    image_width = @image_width,
    image_height = @image_height,
    aspectratio = @aspectratio,
    make = @make,
    model = @model,
    orientation = @orientation,
    duration = @duration,
    gps_lat = @gps_lat,
    gps_lng = @gps_lng,
    gps_alt = @gps_alt,
    file_modified_at = @file_modified_at,
    captured_at = @captured_at,
    capture_date = @capture_date,
    capture_time = @capture_time,
    capture_tz_offset = @capture_tz_offset,
    capture_tz_name = @capture_tz_name
  where uuid = @uuid
`;

// const deleteFromObjectDetailsStatement = `
// delete from object_details
// where uuid = @uuid
// `;

// const insertIntoObjectDetailsStatement = `
// insert into object_details
// (
//   uuid, frame, how_found,
//   region_name, region_type,
//   region_area_x, region_area_y,
//   region_area_w, region_area_h,
//   region_area_unit
// )
// values
// (
//   @uuid, @frame, @how_found,
//   @region_name, @region_type,
//   @region_area_x, @region_area_y,
//   @region_area_w, @region_area_h,
//   @region_area_unit
// )
// `;

const insertIntoExifUpdatesStatement = `
  insert into exif_updates
  (uuid, new_exif_json)
  values
  (@uuid, @new_exif_json)
`;

const updateDescriptionStatement = `
  update metadata
  set description = @description,
    file_modified_at = @fileModifyDate
  where uuid = @uuid
`;

const updateFilenameStatement = `
  update metadata
  set filename = @filename
  where uuid = @uuid
`;

const updateRatingStatement = `
  update metadata
  set rating = @newRating,
    file_modified_at = @fileModifyDate
  where uuid = @uuid
`;

const updateToTrashStatement = `
  update metadata
  set filename = @trashFilename,
    is_trashed = 1, trashed_at = datetime('now','localtime')
  where uuid = @uuid
`;

const untrashItemStatement = `
  update metadata
  set filename = @restoredFilename,
    is_trashed = 0, trashed_at = null
  where uuid = @uuid
`;

const markPrivateStatement = `
  update metadata
  set filename = @newFilename, is_private = 1
  where uuid = @uuid
`;

const unmarkPrivateStatement = `
  update metadata
  set filename = @newFilename, is_private = 0
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
  (collection_id, action, path1, path2)
  values
  (@collection_id, @action, @path1, @path2)
`;

const getPendingExifUpdatesStatemet = `
  select uuid, json_patch_agg(new_exif_json order by update_tm) as new_exif
  from exif_updates
  where update_status = 'P'
  group by uuid
`;
// const deleteObjectDetails = db.prepare(deleteFromObjectDetailsStatement);
// const insertObjectDetails = db.prepare(insertIntoObjectDetailsStatement);
const insertIntoExifUpdates = db.prepare(insertIntoExifUpdatesStatement);
const updateRatingInDb = db.prepare(updateRatingStatement);
const updateDescriptionInDb = db.prepare(updateDescriptionStatement);
const updateFilenameInDb = db.prepare(updateFilenameStatement);
const fileAuditInDb = db.prepare(fileAuditStatement);

function transformDataToMetadataRow(row){
  ['faces','keywords','xmpregion'].forEach(c=>{
    row[c] = row[c] != null ? JSON.stringify(row[c]) : null
  });

  return row;
}

export async function insertMetadataRow(row){
  return await asyncRun(insertIntoMetadataStatement, transformDataToMetadataRow(row));
}
export async function updateMetadataRow(row){
  return await asyncRun(updateMetadataStatement, transformDataToMetadataRow(row));
}
export async function deleteMetadataRow(uuid){
  return await asyncRun(deleteFromMetadataStatement, {uuid});
}

// async function, so it can be run in background
export async function getIndexedFilesModifyTime(collection_id){
  return await asyncAll(`
    select filename, uuid, file_modified_at
    from metadata
    where collection_id = ?
  `, collection_id);
}

export async function getFileName(uuid){
  const result = await asyncGet(getFileNameStatement, {uuid});
  return result.filename;
}

export async function getFileNames(uuid_arr){
  const placeholders = uuid_arr.map(() => '?').join(',');
  const sql = `SELECT uuid, filename FROM metadata WHERE uuid IN (${placeholders})`;
  return await asyncAll(sql, ...uuid_arr);
}

export async function retriveMetadata(uuid){
  return await asyncGet(retriveMetadataStatement, {uuid});
}

export function updateDescription(uuid, description, fileModifyDate){
  updateDescriptionInDb.run({uuid, description, fileModifyDate});
}

export function updateFilename(uuid, filename){
  updateFilenameInDb.run({uuid, filename});
}

export function updateRating(uuid_arr, newRating, fileModifyDate){
  // Use transaction for bulk operations - keep using direct db connection
  let trans = db.transaction(
    function(uuid_arr, newRating, fileModifyDate){
      for (let uuid of uuid_arr){
        logger.info(`${uuid} ${newRating} ${fileModifyDate}`);
        updateRatingInDb.run({uuid, newRating, fileModifyDate});
      }
    }
  )

  trans(uuid_arr, newRating, fileModifyDate);
}

export async function trashItem(uuid, trashFilename){
  logger.info(`Updating to trash ${uuid} ${trashFilename}`);
  return await asyncRun(updateToTrashStatement, {uuid, trashFilename});
}

export async function untrashItem(uuid, restoredFilename){
  logger.info(`Restoring from trash ${uuid} ${restoredFilename}`);
  return await asyncRun(untrashItemStatement, {uuid, restoredFilename});
}

export async function markPrivate(uuid, newFilename){
  logger.info(`Marking private ${uuid} ${newFilename}`);
  return await asyncRun(markPrivateStatement, {uuid, newFilename});
}

export async function unmarkPrivate(uuid, newFilename){
  logger.info(`Unmarking private ${uuid} ${newFilename}`);
  return await asyncRun(unmarkPrivateStatement, {uuid, newFilename});
}

export async function scheduleExif(uuid_arr, new_exif_json){
  // Use transaction for bulk operations - keep using direct db connection
  const insertMany = db.transaction(
    function(uuid_arr, new_exif_json){
      for(let uuid of uuid_arr){
        insertIntoExifUpdates.run({uuid, new_exif_json: JSON.stringify(new_exif_json)})
      }
    }
  );

  insertMany(uuid_arr, new_exif_json);
  return uuid_arr.length;
}

export async function fileAudit(collection_id, action, path1, path2=null){
  return await asyncRun(fileAuditStatement, {collection_id, action, path1, path2});
}

// Batch insert audit entries in a single transaction (avoids N worker-pool roundtrips).
// entries: array of {action, path1, path2}
export function fileAuditBatch(collection_id, entries){
  const insertMany = db.transaction(function(collection_id, entries){
    for (let entry of entries){
      fileAuditInDb.run({collection_id, action: entry.action, path1: entry.path1, path2: entry.path2});
    }
  });

  insertMany(collection_id, entries);
}

// TODO: will be used for scheduled trash cleanup
export async function getTrashedUuids(collection_id){
  let rows = await asyncAll(`select uuid from metadata where collection_id = ? and coalesce(is_trashed, 0) = 1`, collection_id);
  return rows.map(r => r.uuid);
}

export async function getPendingExifUpdates(){
  return await asyncGet(getPendingExifUpdatesStatemet);
}
