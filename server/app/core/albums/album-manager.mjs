import * as fs from 'fs';
const fsPromises = fs.promises;
import * as path from 'path';
import * as indexerDb from '#indexing/indexer-db';
import * as db from './album-db.mjs';
import * as fileOps from '#indexing/file-organizer';
import { getCollection } from '#collections/collection-manager';
import { config } from '#runtime-config';
import { AppError } from '#utils/app-error';

/**
 * Rename an album within a single day. The (album_date, fromAlbumName) pair
 * identifies which folder to rename; the result is named with toAlbumName.
 * Folder paths are computed forward via the pattern engine; we never parse.
 */
export async function updateAlbum(collection_id, album_date, fromAlbumName, toAlbumName) {
  const c = await getCollection(collection_id);
  if (!c) throw new AppError(`Collection ${collection_id} not found`, 'NotFoundError', 'COLLECTION_NOT_FOUND', 404);

  // Rename the on-disk folder if applicable. Only happens for FOLDER_ALBUM
  // collections; VIRTUAL_ALBUM has no folder structure.
  await fileOps.renameAlbumFolder(c, album_date, fromAlbumName, album_date, toAlbumName);

  // Update DB rows: every metadata row matching (collection, album_date,
  // fromAlbumName) and any prefix-nested album beneath it should have its
  // album_name rewritten. Plus the file paths in the filename column need
  // rewriting since the folder moved.
  return await db.updateAlbum(c, album_date, fromAlbumName, toAlbumName);
}

/**
 * Move items to a target (album_date, album_name). For each uuid, the file is
 * physically moved to the target folder and the DB row's album_date and
 * album_name are updated.
 */
export async function moveItemsToAlbum(collection_id, uuid_arr, target_album_date, target_album_name) {
  const c = await getCollection(collection_id);
  if (!c) throw new AppError(`Collection ${collection_id} not found`, 'NotFoundError', 'COLLECTION_NOT_FOUND', 404);

  const newPath = fileOps.albumFolderAbsPath(c, target_album_date, target_album_name);

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

  return db.updateAlbumForItems(c, uuid_arr, target_album_date, target_album_name, movePlan);
}

export async function searchForExistingAlbums(searchStr, wantFullName, collection_id){
  // Look up the collection's placeholder text so the SQL filter matches what
  // the user has configured (default 'TBD'). Without a collection_id we have
  // no placeholder to apply.
  let placeholder = null;
  if (collection_id) {
    let c = await getCollection(collection_id);
    placeholder = c?.placeholder_album_text || null;
  }
  return await db.searchForExistingAlbums(searchStr, wantFullName, collection_id, placeholder)
}
