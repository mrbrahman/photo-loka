import { resizeImage, streamVideo} from './helpers/thumbnails.mjs';

import {getFileName} from '../database/indexer-db.mjs';
import {getDefaultCollection} from '../database/collection-db.mjs';
import * as db from '../database/search-db.mjs';

export async function search(collection_id, searchStr){
  return await db.runSearch(collection_id, searchStr);
}

export async function getAllFromCollection(collection_id){
  return await db.runSearch(collection_id)
}

export async function getAllFromDefaultCollection(){
  let c = await getDefaultCollection();
  return await getAllFromCollection(c.collection_id);
}

export async function getImage(uuid, width, height){
  let filename = await getFileName(uuid);
  return resizeImage(filename, width, height);
}

export async function getVideo(uuid){
  let filename = await getFileName(uuid);
  return streamVideo(uuid, filename);
}

export async function searchForExistingAlbums(searchStr, wantFullName){
  return await db.searchForExistingAlbums(searchStr, wantFullName)
}

export async function getGpsCoordinates() {
  return await db.getGpsCoordinates();
}

export async function searchByGpsCoordinates(collection_id, coordinates){
  return await db.searchByGpsCoordinates(collection_id, coordinates);
}
