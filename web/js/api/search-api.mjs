// Search and data fetching (FTS, geo, timeline, trashed items)

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

// Browser-local date as YYYY-MM-DD (toISOString would give the UTC date).
function localDateString(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Items for the 12 months ending on `date` (YYYY-MM-DD); defaults to the browser's local today.
export async function getTimelineItems(collectionId, date = localDateString()) {
  const params = new URLSearchParams({ date });
  if (collectionId) params.set('collection_id', collectionId);
  let url = `/api/getTimeline?${params}`;
  let res = await authenticatedFetch(url);
  if (!res.ok) throw await res.json().catch(() => ({ error: { message: `${res.status} ${res.statusText}` } }));
  return await res.json();
}

export async function getGpsCoordinates(collectionId) {
  let url = '/api/getGpsCoordinates';
  if (collectionId) url += `?collection_id=${collectionId}`;
  let res = await authenticatedFetch(url);
  if (!res.ok) throw await res.json().catch(() => ({ error: { message: `${res.status} ${res.statusText}` } }));
  return await res.json();
}
