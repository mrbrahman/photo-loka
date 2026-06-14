// Album operations (rename, search for existing)

import { authenticatedFetch } from '../authn.mjs';

/**
 * Rename an album within a single day. Identified by (album_date, currAlbumName);
 * the new name applies to the same album_date.
 */
export async function updateAlbumName(collectionId, albumDate, currAlbumName, newAlbumName) {
  let res = await authenticatedFetch('/api/updateAlbumName', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collection_id: collectionId,
      album_date: albumDate,
      currAlbumName,
      newAlbumName
    })
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
