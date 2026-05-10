// Search and data fetching (FTS, geo, getAll, trashed items)

import { authenticatedFetch } from '../authn.mjs';

export async function searchItems(collectionId, searchText) {
  let res = await authenticatedFetch('/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ collection_id: collectionId, searchText })
  });
  if (!res.ok) throw await res.json().catch(() => ({ error: { message: `${res.status} ${res.statusText}` } }));
  return await res.json();
}

export async function getTrashedItems(collectionId) {
  let res = await authenticatedFetch(`/api/getTrashedItems?collection_id=${collectionId}`);
  if (!res.ok) throw await res.json().catch(() => ({ error: { message: `${res.status} ${res.statusText}` } }));
  return await res.json();
}

export async function searchByGpsCoordinates(collectionId, bounds) {
  let res = await authenticatedFetch('/api/searchByGpsCoordinates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ collection_id: collectionId, bounds })
  });
  if (!res.ok) throw await res.json().catch(() => ({ error: { message: `${res.status} ${res.statusText}` } }));
  return await res.json();
}

export async function getAllItems() {
  let res = await authenticatedFetch('/api/getAll');
  if (!res.ok) throw await res.json().catch(() => ({ error: { message: `${res.status} ${res.statusText}` } }));
  return await res.json();
}

export async function getGpsCoordinates() {
  let res = await authenticatedFetch('/api/getGpsCoordinates');
  if (!res.ok) throw await res.json().catch(() => ({ error: { message: `${res.status} ${res.statusText}` } }));
  return await res.json();
}
