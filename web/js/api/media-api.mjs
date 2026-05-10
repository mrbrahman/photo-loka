// Media item operations (rating, private, trash, move, rename, description)

import { authenticatedFetch } from '../authn.mjs';

export async function updateRating(uuids, newRating) {
  let res = await authenticatedFetch('/api/updateRating', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uuid_arr: uuids, newRating })
  });
  if (!res.ok) throw await res.json().catch(() => ({ error: { message: `${res.status} ${res.statusText}` } }));
}

export async function trashItems(collectionId, uuids) {
  let res = await authenticatedFetch('/api/trashItems', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ collection_id: collectionId, uuid_arr: uuids })
  });
  if (!res.ok) throw await res.json().catch(() => ({ error: { message: `${res.status} ${res.statusText}` } }));
}

export async function togglePrivate(collectionId, uuids, makePrivate) {
  let res = await authenticatedFetch('/api/togglePrivate', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ collection_id: collectionId, uuid_arr: uuids, makePrivate })
  });
  if (!res.ok) throw await res.json().catch(() => ({ error: { message: `${res.status} ${res.statusText}` } }));
}

export async function restoreFromTrash(collectionId, uuids) {
  let res = await authenticatedFetch('/api/restoreFromTrash', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ collection_id: collectionId, uuid_arr: uuids })
  });
  if (!res.ok) throw await res.json().catch(() => ({ error: { message: `${res.status} ${res.statusText}` } }));
}

export async function cleanupTrash(collectionId, uuids) {
  let res = await authenticatedFetch('/api/cleanupTrash', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ collection_id: collectionId, uuid_arr: uuids })
  });
  if (!res.ok) throw await res.json().catch(() => ({ error: { message: `${res.status} ${res.statusText}` } }));
}

export async function emptyTrash(collectionId, uuids) {
  let res = await authenticatedFetch('/api/emptyTrash', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ collection_id: collectionId, uuid_arr: uuids })
  });
  if (!res.ok) throw await res.json().catch(() => ({ error: { message: `${res.status} ${res.statusText}` } }));
}

export async function moveItems(collectionId, uuids, newAlbumName) {
  let res = await authenticatedFetch('/api/moveItems', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ collection_id: collectionId, uuid_arr: uuids, new_album_name: newAlbumName })
  });
  if (!res.ok) throw await res.json().catch(() => ({ error: { message: `${res.status} ${res.statusText}` } }));
}

export async function renameFile(collectionId, uuid, newBasename) {
  let res = await authenticatedFetch('/api/renameFile', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ collection_id: collectionId, uuid, newBasename })
  });
  if (!res.ok) throw await res.json().catch(() => ({ error: { message: `${res.status} ${res.statusText}` } }));
}

export async function updateDescription(uuid, description) {
  let res = await authenticatedFetch('/api/updateDescription', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uuid, description })
  });
  if (!res.ok) throw await res.json().catch(() => ({ error: { message: `${res.status} ${res.statusText}` } }));
}

export async function getItemInfo(uuid) {
  let res = await authenticatedFetch(`/api/getItemInfo?uuid=${uuid}`);
  if (!res.ok) throw await res.json().catch(() => ({ error: { message: `${res.status} ${res.statusText}` } }));
  return await res.json();
}
