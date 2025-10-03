import * as fs from 'fs';
const fsPromises = fs.promises;
import * as path from 'path';
import { fdir } from 'fdir';

import dateformat from 'dateformat';

import * as db from './indexer-db.mjs';
import { config } from '../../config.mjs';

export async function lsRecursive(dir) {
  return new fdir()
    .withFullPaths()
    .onlyFiles()
    .crawl(dir)
    .withPromise();
}

export async function listAllFilesForCollection(collection) {
  let start = performance.now();
  console.log(`starting to list all files for collection path: ${collection.collection_path}`);

  let files = await lsRecursive(collection.collection_path);
  
  console.log(`finished listing files in ${(performance.now() - start)/1000} secs`)

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

export async function placeFileInCollection(collection, filename, file_date, inPlace=false){
  let album, albumFilename,
    dir = path.dirname(filename);

  if(inPlace){
    // In place indexing. To be used for 
    // 1) first time in-place indexing after setting up collection
    // 2) collections that don't have specific listen_paths (i.e. new files come and 
    //    sit directly in the collection_path)

    album = collection.album_type=='FOLDER_ALBUM' ? 
      // relative folder becomes the album
      dir.replace(collection.collection_path, "").replace(/^\//, '') : 
      // album is just the date
      dateformat(file_date, 'yyyy-mm-dd');  // TODO: timezone?
  
    albumFilename = filename;
    await logChange('in-place', filename);
  } else {
    // i.e. file needs to be moved from listen_path to collection_path

    // extract format:
    // For FOLDER_ALBUM, need to move file to the corresponding folder
    // based on pattern specified in collection.
    // For VIRTUAL_ALBUM, files will sit in collection_path, i.e. there
    // is no sub-folder
    // TODO: For VIRTUAL_ALBUM, does it make sense to move to similar path like thumbnails?

    let subFolder = collection.album_type=='FOLDER_ALBUM' ? 
      dateformat(file_date, collection.apply_folder_pattern) : '';
    
    let newFolder = path.join(collection.collection_path, subFolder);
    let newFileName = path.join(newFolder, path.basename(filename));

    await moveItem(filename, newFileName);

    album = collection.album_type=='FOLDER_ALBUM' ? 
      // newly created sub folder becomes the album
      subFolder : 
      // album is just the date
      dateformat(file_date, 'yyyy-mm-dd');  // TODO: timezone?
    albumFilename = newFileName;
  }

  return {
    album: album,
    filename: albumFilename
  }
}

export async function renameFolder(currAlbum, newAlbum){
  try {
    fs.renameSync(currAlbum, newAlbum);
    await logChange('move', currAlbum, newAlbum);
  } catch (err) {
    console.log(err)
    throw {code: err.code, message: err.message};
  }
}

export async function moveItem(src, dest, silent = false){
  try {
    let targetDir = path.dirname(dest);
    if(!fs.existsSync(targetDir)){
      await fsPromises.mkdir(targetDir, {recursive: true});
      if(!silent) await logChange('create-dir', null, targetDir);
    }
    // try to fist rename the file. in case the file is in the same mountpoint
    // this will be faster than copying

    await fsPromises.rename(src, dest);
  } catch (err) {
    // fs.renameSync does not work across mountpoints
    // first copy the file and then remove the original file
    // workaround found at https://stackoverflow.com/questions/43206198/what-does-the-exdev-cross-device-link-not-permitted-error-mean
    
    if(err.code !== 'EXDEV'){
      throw `Error while move: ${err.code} ${err.message}`;
    }
    await fsPromises.cp(src, dest, {preserveTimestamps: true, errorOnExist: true});
    fs.unlinkSync(src);
  }

  // if we've reached till here, the move has been successful
  if(!silent) await logChange('move', src, dest)
}

export async function deleteFile(fileName){
  fs.unlinkSync(fileName);
  await logChange('delete', fileName)
}

export async function moveFileToTrash(uuid_arr){
  // Rename file to start with '.Trash_' and update trashed flag in db
  for(let uuid of uuid_arr){
    let f = await db.getFileName(uuid),
      filename = path.basename(f),
      trashFilename = path.join(path.dirname(f), `.Trash_${filename}`);
    
    await moveItem(f, trashFilename);
    await db.trashItem(uuid, trashFilename);
  }
}

async function logChange(action, path1, path2){
  if(!config.auditFiles){
    return
  }

  // make an entry into db rather than updating a file
  // this will help with select when needs to be used (for e.g. select after a specific timestamp etc)
  // also one less file to maintain
  await db.fileAudit(action, path1, path2)
}
