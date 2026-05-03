import * as path from 'path';
import * as db from './indexer-db.mjs';
import * as fileOps from './file-organizer.mjs';
import * as thumbnails from '#media/thumbnail-manager';
import * as faceExtractor from '#media/face-extractor';
import * as mlDb from '#ml/ml-db';
import * as mlClient from '#ml/ml-client';
import { createLogger } from '#utils/logger';

const logger = createLogger(import.meta.url);

export async function renameFile(collection_id, uuid, newBasename){
  let oldPath = await db.getFileName(uuid);
  let dir = path.dirname(oldPath);
  let newPath = path.join(dir, newBasename);

  if (oldPath === newPath) return;

  await fileOps.moveItem(collection_id, oldPath, newPath);
  db.updateFilename(uuid, newPath);
}

export async function togglePrivate(collection_id, uuid_arr, makePrivate){
  if(makePrivate){
    await fileOps.markFilePrivate(collection_id, uuid_arr);
  } else {
    await fileOps.unmarkFilePrivate(collection_id, uuid_arr);
  }
}

export async function moveToTrash(collection_id, uuid_arr){
  await fileOps.moveFileToTrash(collection_id, uuid_arr);
}

export async function restoreFromTrash(collection_id, uuid_arr){
  await fileOps.restoreFromTrash(collection_id, uuid_arr);
}

export async function cleanupTrash(collection_id, uuid_arr){
  for(let uuid of uuid_arr){
    await fileOps.cleanupTrashFile(collection_id, uuid);
    // deletes all files starting with uuid in thumbs dir (thumbnails, video screenshots, compressed videos)
    thumbnails.deleteImageThumbnails(uuid);

    // ML cleanup: face data, face thumbnails, and ML service embeddings
    let clusterIds = await mlDb.deleteFaceData(uuid);
    faceExtractor.deleteFaceThumbnails(uuid, clusterIds);
    await mlClient.cleanupMLData(uuid);

    await db.deleteMetadataRow(uuid);
    logger.info(`Cleaned up trash for ${uuid}`);
  }
}

// TODO: will be used for scheduled trash cleanup
export async function emptyTrash(collection_id){
  let uuids = await db.getTrashedUuids(collection_id);
  if(uuids.length === 0) return;
  await cleanupTrash(collection_id, uuids);
  logger.info(`Emptied trash for collection ${collection_id} - ${uuids.length} items`);
}
