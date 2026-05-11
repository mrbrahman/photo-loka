// Album operations (rename, search for existing)

import { authenticatedFetch } from '../authn.mjs';

export async function updateAlbumName(collectionId, currAlbumName, newAlbumName) {
  let res = await authenticatedFetch('/api/updateAlbumName', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ collection_id: collectionId, currAlbumName, newAlbumName })
  });
  if (!res.ok) {
    let err = await res.json().catch(() => ({ error: { message: `${res.status} ${res.statusText}` } }));
    throw err;
  }
}

export async function searchForExistingAlbums(searchStr, wantFullName, collectionId) {
  let url = `/api/searchForExistingAlbums?searchStr=${encodeURIComponent(searchStr)}&wantFullName=${wantFullName}`;
  if (collectionId) url += `&collection_id=${collectionId}`;
  let res = await authenticatedFetch(url);
  if (!res.ok) throw await res.json().catch(() => ({ error: { message: `${res.status} ${res.statusText}` } }));
  return await res.json();
}
