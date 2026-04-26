import dateFormat from 'dateformat';
import * as path from 'path';
import * as db from './indexer-db.mjs';
import * as fileOps from './file-organizer.mjs';
import * as exifManager from '#media/exif-manager';
import { createLogger } from '#utils/logger';

const logger = createLogger(import.meta.url);

export async function refreshMetadata(uuid, filename){
  if(!filename){
    filename = await db.getFileName(uuid);
  }
  logger.info(`Re-extracting metadata for ${filename}`);

  let metadata = await exifManager.getMetadata(filename);
  metadata['uuid'] = uuid;

  await db.updateMetadataRow(metadata)
}

export function updateDescription(uuid, description){
  let fileModifyDate = dateFormat(new Date(), 'isoDateTime');

  db.updateDescription(uuid, description, fileModifyDate);
  db.scheduleExif([uuid], {ImageDescription: description, FileModifyDate: fileModifyDate});
}

export async function renameFile(collection_id, uuid, newBasename){
  let oldPath = await db.getFileName(uuid);
  let dir = path.dirname(oldPath);
  let newPath = path.join(dir, newBasename);

  if (oldPath === newPath) return;

  await fileOps.moveItem(collection_id, oldPath, newPath);
  db.updateFilename(uuid, newPath);
}

export function updateRating(uuid_arr, newRating){
  // we also update the file modify date so that next time server starts up, it doesn't
  // see this as a new file and re-indexes it
  let fileModifyDate = dateFormat(new Date(), 'isoDateTime');

  db.updateRating(uuid_arr, newRating, fileModifyDate);
  db.scheduleExif(uuid_arr, {Rating: newRating, FileModifyDate: fileModifyDate});
}

export async function togglePrivate(collection_id, uuid_arr, makePrivate){
  if(makePrivate){
    await fileOps.markFilePrivate(collection_id, uuid_arr);
  } else {
    await fileOps.unmarkFilePrivate(collection_id, uuid_arr);
  }
}