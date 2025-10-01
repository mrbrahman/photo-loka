import dateFormat from 'dateformat';
import * as db from './indexer-db.mjs';
import * as exifManager from '../media/exif-manager.mjs';

export async function refreshMetadata(uuid, filename){
  if(!filename){
    filename = await db.getFileName(uuid);
  }
  console.log(`Re-extracting metadata for ${filename}`);

  let metadata = await exifManager.getMetadata(filename);
  metadata['uuid'] = uuid;

  await db.updateMetadataRow(metadata)
}

export function updateRating(uuid_arr, newRating){
  // we also update the file modify date so that next time server starts up, it doesn't
  // see this as a new file and re-indexes it
  let fileModifyDate = dateFormat(new Date(), 'isoDateTime');

  db.updateRating(uuid_arr, newRating, fileModifyDate);
  db.scheduleExif(uuid_arr, {Rating: newRating, FileModifyDate: fileModifyDate});
}