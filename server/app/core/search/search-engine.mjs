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

export async function search(collection_id, searchStr, trashed = false, groupByDay = true, orderBy = null){
  const aiQuery = searchStr ? extractAiQuery(searchStr.trim()) : null;

  if (aiQuery) {
    const mlResult = await searchByText(aiQuery);
    const uuids = (mlResult.results || []).map(r => r.image_id);
    if (uuids.length === 0) return [];

    const inList = uuids.map(u => `'${u}'`).join(',');
    const rawFilter = `raw:"uuid in (${inList})"`;
    return await db.runSearch(collection_id, rawFilter, trashed, false, groupByDay, orderBy);
  }

  return await db.runSearch(collection_id, searchStr, trashed, false, groupByDay, orderBy);
}

export async function getAllFromCollection(collection_id, fromDate, toDate){
  // Default to last 365 days when no explicit range provided. Search and
  // other modes (trash, geo) intentionally don't apply this window - those
  // are user-driven queries where we want to see everything that matches.
  if (!fromDate) {
    const d = new Date();
    d.setDate(d.getDate() - 365);
    fromDate = d.toISOString().slice(0, 10);
  }
  return await db.runSearch(collection_id, null, false, false, true, null, { fromDate, toDate })
}

export async function getAllFromDefaultCollection(fromDate, toDate){
  let c = await getDefaultCollection();
  return await getAllFromCollection(c.collection_id, fromDate, toDate);
}

export async function getItemInfo(uuid){
  return await db.getItemInfo(uuid);
}

export async function getGpsCoordinates(collection_id) {
  return await db.getGpsCoordinates(collection_id);
}

export async function searchByGpsCoordinates(collection_id, bounds){
  return await db.searchByGpsCoordinates(collection_id, bounds);
}

export async function getTrashedItems(collection_id){
  return await db.runSearch(collection_id, null, true);
}