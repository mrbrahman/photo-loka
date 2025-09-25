import { asyncGet, asyncAll, asyncRun } from './db-pool.mjs';
import { db } from './sqlite-database.mjs'; // For transaction-based operations


const deleteFromMetadataStatement = `
delete from metadata
where uuid = @uuid
`;

const insertIntoMetadataStatement = `
insert into metadata
(
  collection_id, uuid, album, filename,
  description, filesize, ext, mimetype, mediatype,
  keywords, xmpregion, faces, objects, rating, 
  image_width, image_height, aspectratio,
  make, model, orientation, duration, 
  gps_lat, gps_long, gps_alt, geolocation_api_json, geo_address,
  datetime_original, create_date, file_modify_date, file_date
)
values
(
  @collection_id, @uuid, @album, @filename,
  @description, @filesize, @ext, @mimetype, @mediatype,
  @keywords, @xmpregion, @faces, @objects, @rating, 
  @image_width, @image_height, @aspectratio,
  @make, @model, @orientation, @duration, 
  @gps_lat, @gps_long, @gps_alt, @geolocation_api_json, @geo_address,
  @datetime_original, @create_date, @file_modify_date, @file_date
)
`;

const updateMetadataStatement = `
  update metadata
  set
    -- collection_id = @collection_id,
    -- album = @album,
    -- filename = @filename,
    description = @description,
    filesize = @filesize,
    ext = @ext,
    mimetype = @mimetype,
    mediatype = @mediatype,
    keywords = @keywords,
    xmpregion = @xmpregion,
    faces = @faces,
    objects = @objects,
    rating = @rating,
    image_width = @image_width,
    image_height = @image_height,
    aspectratio = @aspectratio,
    make = @make,
    model = @model,
    orientation = @orientation,
    duration = @duration,
    gps_lat = @gps_lat,
    gps_long = @gps_long,
    gps_alt = @gps_alt,
    geolocation_api_json = @geolocation_api_json,
    geo_address = @geo_address,
    datetime_original = @datetime_original,
    create_date = @create_date,
    file_modify_date = @file_modify_date,
    file_date = @file_date
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

function transformDataToMetadataRow(row){
  ['faces','objects','keywords','xmpregion','geolocation_api_json'].forEach(c=>{
    row[c] = JSON.stringify(row[c])
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
    select filename, uuid, file_modify_date
    from metadata
    where collection_id = ?
  `, collection_id);
}

export async function updateAlbum(collection_id, fromAlbum, toAlbum, updateFileName){
  const sql = `
    update metadata
    set album = @toAlbum
      ${updateFileName ? ", filename = replace(filename, @fromAlbum, @toAlbum)" : ''} 
    where collection_id = @collection_id
    and album = @fromAlbum
  `;
  
  return await asyncRun(sql, {collection_id, fromAlbum, toAlbum});
}

export function updateAlbumForItems(uuid_arr, toAlbum, updateFileName){
  // Use transaction for bulk operations - keep using direct db connection
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


export async function getFileName(uuid){
  const result = await asyncGet(getFileNameStatement, {uuid});
  return result.filename;
}

export async function retriveMetadata(uuid){
  return await asyncGet(retriveMetadataStatement, {uuid});
}

export function updateRating(uuid_arr, newRating, fileModifyDate){
  // Use transaction for bulk operations - keep using direct db connection
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

export async function trashItem(uuid, trashFilename){
  console.log(`Updating to trash ${uuid} ${trashFilename}`);
  return await asyncRun(updateToTrashStatement, {uuid, trashFilename});
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

export async function fileAudit(action, path1, path2=null){
  return await asyncRun(fileAuditStatement, {action, path1, path2});
}

export async function getPendingExifUpdates(){
  return await asyncGet(getPendingExifUpdatesStatemet);
}
