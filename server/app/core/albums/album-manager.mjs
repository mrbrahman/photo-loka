import * as fs from 'fs';
const fsPromises = fs.promises;
import * as path from 'path';
import * as indexerDb from '#indexing/indexer-db';
import * as db from './album-db.mjs';
import * as fileOps from '#indexing/file-organizer';
import { getCollection } from '#collections/collection-manager';
import { config } from '#runtime-config';

export async function updateAlbum(collection_id, fromAlbum, toAlbum){
  let c = await getCollection(collection_id);
  let currFolderName=path.join(c.collection_path,fromAlbum),
  newFolderName=path.join(c.collection_path,toAlbum)
  
  if(c.album_type=="FOLDER_ALBUM"){
    await fileOps.renameFolder(collection_id, currFolderName, newFolderName);  
  }
  
  return await db.updateAlbum(
    collection_id, fromAlbum, toAlbum, 
    c.album_type=="FOLDER_ALBUM" ? true : false  // whether to update file name
  );
}

export async function moveItemsToAlbum(collection_id, uuid_arr, newAlbumName){
  let c = await getCollection(collection_id),
    newPath = path.join(c.collection_path, newAlbumName);

  // Ensure target directory exists once, not per-item
  await fsPromises.mkdir(newPath, { recursive: true });

  // Single DB call to fetch all filenames
  const files = await indexerDb.getFileNames(uuid_arr);
  const fileMap = new Map(files.map(f => [f.uuid, f.filename]));

  // Build move plan: [{src, dest}, ...]
  const movePlan = uuid_arr.map(uuid => {
    let src = fileMap.get(uuid);
    let dest = path.join(newPath, path.basename(src));
    return { src, dest };
  });

  // Parallel renames - fs.rename on same mountpoint is safe to parallelize
  // Falls back to copy+delete for cross-device moves
  let moveResults = await Promise.allSettled(movePlan.map(({ src, dest }) => {
    return fsPromises.rename(src, dest).catch(async (err) => {
      if (err.code === 'EXDEV') {
        await fsPromises.cp(src, dest, { preserveTimestamps: true, errorOnExist: true });
        fs.unlinkSync(src);
      } else {
        throw err;
      }
    });
  }));

  // Check for failures
  let failures = moveResults.filter(r => r.status === 'rejected');
  if (failures.length > 0) {
    throw failures[0].reason;
  }

  // Batch audit log - per-file 'move' entries in a single transaction
  if (config.auditFiles) {
    let auditEntries = movePlan.map(({ src, dest }) => ({ action: 'move', path1: src, path2: dest }));
    indexerDb.fileAuditBatch(collection_id, auditEntries);
  }

  return db.updateAlbumForItems(
    uuid_arr, newAlbumName,
    c.album_type == "FOLDER_ALBUM" ? true : false  // whether to update file name
  );
}

export async function searchForExistingAlbums(searchStr, wantFullName, collection_id){
  return await db.searchForExistingAlbums(searchStr, wantFullName, collection_id)
}