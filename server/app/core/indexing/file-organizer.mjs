import * as fs from 'fs';
const fsPromises = fs.promises;
import * as path from 'path';
import { fdir } from 'fdir';
import { createLogger } from '#utils/logger';
import { fmtTime } from '#utils/time-format';
import { AppError } from '#utils/app-error';

import { format as formatPattern, parse as parsePattern } from '#utils/folder-pattern';

import * as db from './indexer-db.mjs';
import { config } from '#runtime-config';

const logger = createLogger(import.meta.url);

export async function lsRecursive(dir) {
  return new fdir()
    .withFullPaths()
    //.onlyFiles()
    .crawl(dir)
    .withPromise();
}

export async function listAllFilesForCollection(collection) {
  let start = performance.now();
  logger.info(`starting to list all files for collection path: ${collection.collection_path}`);

  let files = await lsRecursive(collection.collection_path);

  logger.info(`finished listing files in ${fmtTime(performance.now() - start)}`)

  return files;
}

export async function getFilesMtime(dir) {
  let files = await lsRecursive(dir);

  let result = files.map(f => {
    return {
      filename: f,
      file_modify_date: Math.floor(fs.statSync(f).mtimeMs / 1000) // Unix Epoch
    };
  });

  // convert output into hash map (Javascript Object)
  // {<filename_1>: {mtime: <file_modify_date_1>}, ... <filename_n>: {mtime: <file_modify_date_n>}}
  return result.reduce(function (acc, curr) {
    acc[curr.filename] = { mtime: curr.file_modify_date };
    return acc;
  }, {});
}

// Convert a date-like string ('YYYY-MM-DD ...' or ISO with timezone) into the
// {yyyy, mm, dd} fields expected by the moustache pattern engine. Returns null
// if the input doesn't have a parseable date prefix.
function dateFieldsFrom(captured_at) {
  if (!captured_at) return null;
  const d = new Date(captured_at);
  if (isNaN(d.getTime())) {
    // Fallback: parse the leading 'YYYY-MM-DD' if the string starts with one.
    const m = String(captured_at).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    return { yyyy: m[1], mm: m[2], dd: m[3] };
  }
  return {
    yyyy: String(d.getFullYear()),
    mm: String(d.getMonth() + 1).padStart(2, '0'),
    dd: String(d.getDate()).padStart(2, '0')
  };
}

function dateStringFromFields(fields) {
  if (!fields) return null;
  return `${fields.yyyy}-${fields.mm}-${fields.dd}`;
}

/**
 * Place a file in its collection and determine its album split.
 *
 * Returns: { album_date: 'YYYY-MM-DD', album_name: '...', filename: <abs path> }
 *
 * In intake mode (inPlace=false): file is moved into the collection at a path
 * computed forward via the pattern engine using captured_at's date and an empty
 * album_name (later optionally appended with collection.placeholder_album_text).
 *
 * In inPlace mode (inPlace=true): file is already at its target location;
 * we parse the parent folder against the collection's apply_folder_pattern
 * to extract album_date and album_name. If the path doesn't match the
 * pattern (e.g. user placed the file in an unstructured folder), we fall
 * back to captured_at's date for album_date and an empty album_name.
 */
export async function placeFileInCollection(collection, filename, captured_at, inPlace = false) {
  if (inPlace) {
    return placeInPlace(collection, filename, captured_at);
  }
  return placeViaIntake(collection, filename, captured_at);
}

async function placeInPlace(collection, filename, captured_at) {
  let album_date, album_name = '';

  if (collection.album_type === 'FOLDER_ALBUM' && collection.apply_folder_pattern) {
    const relDir = path.relative(collection.collection_path, path.dirname(filename));
    const parsed = parsePattern(relDir, collection.apply_folder_pattern);
    if (parsed && parsed.yyyy && parsed.mm && parsed.dd) {
      album_date = `${parsed.yyyy}-${parsed.mm}-${parsed.dd}`;
      album_name = parsed.album || '';
    } else {
      // Folder doesn't match the pattern. Fall back to captured_at's date.
      const f = dateFieldsFrom(captured_at);
      album_date = dateStringFromFields(f) || '1970-01-01';
      album_name = '';
    }
  } else {
    // VIRTUAL_ALBUM has no folder structure - album_date comes from captured_at,
    // album_name is empty.
    const f = dateFieldsFrom(captured_at);
    album_date = dateStringFromFields(f) || '1970-01-01';
    album_name = '';
  }

  await logChange(collection.collection_id, 'in-place', null, filename);

  return { album_date, album_name, filename };
}

async function placeViaIntake(collection, filename, captured_at) {
  // Intake creates a fresh folder for this file. album_date comes from
  // captured_at; album_name defaults to the collection's placeholder text
  // (so the user can later rename it from the gallery).
  const fields = dateFieldsFrom(captured_at);
  const album_date = dateStringFromFields(fields) || '1970-01-01';
  const album_name = collection.placeholder_album_text || '';

  if (collection.album_type === 'FOLDER_ALBUM') {
    if (!collection.apply_folder_pattern) {
      throw new Error(`Collection ${collection.collection_id} is FOLDER_ALBUM but has no apply_folder_pattern`);
    }
    const subFolder = formatPattern({ ...fields, album: album_name }, collection.apply_folder_pattern);
    const newFolder = path.join(collection.collection_path, subFolder);
    const newFileName = path.join(newFolder, path.basename(filename));

    await moveItem(collection.collection_id, filename, newFileName);

    return { album_date, album_name, filename: newFileName };
  }

  // VIRTUAL_ALBUM: file goes directly into collection_path. album_name stays
  // whatever placeholder was set, but there's no actual folder structure.
  const newFileName = path.join(collection.collection_path, path.basename(filename));
  await moveItem(collection.collection_id, filename, newFileName);
  return { album_date, album_name, filename: newFileName };
}

/**
 * Rename the on-disk folder corresponding to (currAlbumDate, currAlbumName)
 * to one corresponding to (newAlbumDate, newAlbumName), using the
 * collection's apply_folder_pattern. Both old and new sub-paths are
 * computed forward via the pattern engine - we never need to reverse-parse.
 */
export async function renameAlbumFolder(collection, currAlbumDate, currAlbumName, newAlbumDate, newAlbumName) {
  if (collection.album_type !== 'FOLDER_ALBUM' || !collection.apply_folder_pattern) {
    return; // VIRTUAL_ALBUM has no folder to rename.
  }
  const currFields = dateFieldsFromString(currAlbumDate);
  const newFields = dateFieldsFromString(newAlbumDate);
  const currSub = formatPattern({ ...currFields, album: currAlbumName || '' }, collection.apply_folder_pattern);
  const newSub  = formatPattern({ ...newFields,  album: newAlbumName  || '' }, collection.apply_folder_pattern);

  const currFolderName = path.join(collection.collection_path, currSub);
  const newFolderName  = path.join(collection.collection_path, newSub);

  if (currFolderName === newFolderName) return;

  try {
    const exists = await fsPromises.access(newFolderName).then(() => true).catch(() => false);
    if (exists) {
      throw new AppError('Destination folder already exists', 'ConflictError', 'FOLDER_EXISTS', 409);
    }
    await fsPromises.rename(currFolderName, newFolderName);
    await logChange(collection.collection_id, 'move', currFolderName, newFolderName);
  } catch (err) {
    logger.error(err);
    if (err instanceof AppError) throw err;
    throw new AppError(err.message, 'FileSystemError', err.code || 'RENAME_FAILED', 500);
  }
}

function dateFieldsFromString(dateStr) {
  if (!dateStr) return { yyyy: '1970', mm: '01', dd: '01' };
  const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return { yyyy: '1970', mm: '01', dd: '01' };
  return { yyyy: m[1], mm: m[2], dd: m[3] };
}

/**
 * Compute the absolute on-disk folder path for an (album_date, album_name)
 * pair within a collection. Used by the move-items flow to know where to
 * put files. Empty album_name still yields a valid (date-only) folder.
 */
export function albumFolderAbsPath(collection, album_date, album_name) {
  if (collection.album_type !== 'FOLDER_ALBUM' || !collection.apply_folder_pattern) {
    return collection.collection_path;
  }
  const fields = dateFieldsFromString(album_date);
  const sub = formatPattern({ ...fields, album: album_name || '' }, collection.apply_folder_pattern);
  return path.join(collection.collection_path, sub);
}

export async function moveItem(collection_id, src, dest, silent = false){
  try {
    let targetDir = path.dirname(dest);
    if(!fs.existsSync(targetDir)){
      await fsPromises.mkdir(targetDir, {recursive: true});
      if(!silent) await logChange(collection_id, 'create-dir', null, targetDir);
    }
    // try to fist rename the file. in case the file is in the same mountpoint
    // this will be faster than copying

    await fsPromises.rename(src, dest);
  } catch (err) {
    // fs.renameSync does not work across mountpoints
    // first copy the file and then remove the original file
    // workaround found at https://stackoverflow.com/questions/43206198/what-does-the-exdev-cross-device-link-not-permitted-error-mean

    if(err.code !== 'EXDEV'){
      throw new AppError(`Error while move: ${err.code} ${err.message}`, 'FileSystemError', err.code || 'MOVE_FAILED', 500);
    }
    await fsPromises.cp(src, dest, {preserveTimestamps: true, errorOnExist: true});
    fs.unlinkSync(src);
  }

  // if we've reached till here, the move has been successful
  if(!silent) await logChange(collection_id, 'move', src, dest)
}

export async function deleteFile(collection_id, fileName){
  fs.unlinkSync(fileName);
  await logChange(collection_id, 'delete', fileName)
}

export async function moveFileToTrash(collection_id, uuid_arr){
  // Rename file to start with '.Trash_' and update trashed flag in db
  for(let uuid of uuid_arr){
    let f = await db.getFileName(uuid),
      filename = path.basename(f),
      trashFilename = path.join(path.dirname(f), `.Trash_${filename}`);

    await moveItem(collection_id, f, trashFilename);
    await db.trashItem(uuid, trashFilename);
  }
}

export async function restoreFromTrash(collection_id, uuid_arr){
  for(let uuid of uuid_arr){
    let f = await db.getFileName(uuid),
      dir = path.dirname(f),
      filename = path.basename(f),
      restoredFilename = path.join(dir, filename.replace(/^\.Trash_/, ''));

    await moveItem(collection_id, f, restoredFilename);
    await db.untrashItem(uuid, restoredFilename);
  }
}

export async function cleanupTrashFile(collection_id, uuid){
  let f = await db.getFileName(uuid);
  await deleteFile(collection_id, f);
}

export async function markFilePrivate(collection_id, uuid_arr){
  for(let uuid of uuid_arr){
    let f = await db.getFileName(uuid),
      dir = path.dirname(f),
      filename = path.basename(f),
      privateFilename = path.join(dir, `.${filename}`);

    await moveItem(collection_id, f, privateFilename);
    await db.markPrivate(uuid, privateFilename);
  }
}

export async function unmarkFilePrivate(collection_id, uuid_arr){
  for(let uuid of uuid_arr){
    let f = await db.getFileName(uuid),
      dir = path.dirname(f),
      filename = path.basename(f),
      publicFilename = path.join(dir, filename.replace(/^\./, ''));

    await moveItem(collection_id, f, publicFilename);
    await db.unmarkPrivate(uuid, publicFilename);
  }
}

async function logChange(collection_id, action, path1, path2){
  if(!config.auditFiles){
    return
  }

  // make an entry into db rather than updating a file
  // this will help with select when needs to be used (for e.g. select after a specific timestamp etc)
  // also one less file to maintain
  await db.fileAudit(collection_id, action, path1, path2)
}
