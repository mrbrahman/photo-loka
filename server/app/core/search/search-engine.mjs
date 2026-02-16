import {getDefaultCollection} from '#collections/collection-manager';
import * as db from './search-db.mjs';

export async function search(collection_id, searchStr, trashed = false, groupByAlbum = true){
  return await db.runSearch(collection_id, searchStr, trashed, groupByAlbum);
}

export async function getAllFromCollection(collection_id){
  return await db.runSearch(collection_id)
}

export async function getAllFromDefaultCollection(){
  let c = await getDefaultCollection();
  return await getAllFromCollection(c.collection_id);
}

export async function getGpsCoordinates() {
  return await db.getGpsCoordinates();
}

export async function searchByGpsCoordinates(collection_id, coordinates){
  return await db.searchByGpsCoordinates(collection_id, coordinates);
}