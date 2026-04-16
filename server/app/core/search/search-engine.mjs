import {getDefaultCollection} from '#collections/collection-manager';
import { searchByText } from '#ml/ml-manager';
import { createLogger } from '#utils/logger';
import * as db from './search-db.mjs';

const logger = createLogger(import.meta.url);

// Match ai: key with optional quoted value
const AI_SEARCH_RE = /^ai:"?(.+?)"?$/i;

function extractAiQuery(searchStr) {
  const match = searchStr.match(AI_SEARCH_RE);
  return match ? match[1] : null;
}

export async function search(collection_id, searchStr, trashed = false, groupByAlbum = true, orderBy = null){
  const aiQuery = searchStr ? extractAiQuery(searchStr.trim()) : null;

  if (aiQuery) {
    const mlResult = await searchByText(aiQuery);
    const uuids = (mlResult.results || []).map(r => r.image_id);
    if (uuids.length === 0) return [];

    const inList = uuids.map(u => `'${u}'`).join(',');
    const rawFilter = `raw:"uuid in (${inList})"`;
    return await db.runSearch(collection_id, rawFilter, trashed, groupByAlbum, orderBy);
  }

  return await db.runSearch(collection_id, searchStr, trashed, groupByAlbum, orderBy);
}

export async function getAllFromCollection(collection_id){
  return await db.runSearch(collection_id)
}

export async function getAllFromDefaultCollection(){
  let c = await getDefaultCollection();
  return await getAllFromCollection(c.collection_id);
}

export async function getItemInfo(uuid){
  return await db.getItemInfo(uuid);
}

export async function getGpsCoordinates() {
  return await db.getGpsCoordinates();
}

export async function searchByGpsCoordinates(collection_id, bounds){
  return await db.searchByGpsCoordinates(collection_id, bounds);
}