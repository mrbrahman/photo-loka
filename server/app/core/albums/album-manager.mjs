import * as path from 'path';
import * as indexerDb from '#indexing/indexer-db';
import * as db from './album-db.mjs';
import * as fileOps from '#indexing/file-organizer';
import { getCollection } from '#collections/collection-manager';

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
  
  // TODO: convert this to array of promises?
  for(let uuid of uuid_arr){
    let f = await indexerDb.getFileName(uuid);
    await fileOps.moveItem(collection_id, f, path.join(newPath, path.basename(f)));
  }
  return db.updateAlbumForItems(
    uuid_arr, newAlbumName,
    c.album_type=="FOLDER_ALBUM" ? true : false  // whether to update file name
  );
}

export async function searchForExistingAlbums(searchStr, wantFullName){
  return await db.searchForExistingAlbums(searchStr, wantFullName)
}