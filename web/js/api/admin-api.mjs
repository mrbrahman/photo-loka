// Admin operations (users, collections, frames, indexing, intakes)

import { authenticatedFetch } from '../authn.mjs';

// Standard error: attempt to parse the server's JSON error body.
// Falls back to { error: { message: '<status> <statusText>' } } if parsing fails.
function throwError(res) {
  return res.json()
    .catch(() => ({ error: { message: `${res.status} ${res.statusText}` } }))
    .then(body => { throw body; });
}

// --- Users ---

export async function getUsers() {
  let res = await authenticatedFetch('/api/admin/users');
  if (!res.ok) return throwError(res);
  return await res.json();
}

export async function createUser(username, password, role) {
  let res = await authenticatedFetch('/api/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, role })
  });
  if (!res.ok) return throwError(res);
  return await res.json();
}

export async function unlockUser(userId) {
  let res = await authenticatedFetch(`/api/admin/users/${userId}/unlock`, { method: 'POST' });
  if (!res.ok) return throwError(res);
}

export async function changeUserRole(userId, newRole) {
  let res = await authenticatedFetch(`/api/admin/users/${userId}/role`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: newRole })
  });
  if (!res.ok) return throwError(res);
}

export async function generateToken(userId, expiresInDays) {
  let res = await authenticatedFetch(`/api/admin/users/${userId}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresInDays })
  });
  if (!res.ok) return throwError(res);
  return await res.json();
}

// --- Frames ---

export async function getAllFrames() {
  let res = await authenticatedFetch('/api/admin/getAllFrames');
  if (!res.ok) return throwError(res);
  return await res.json();
}

export async function createFrame(data) {
  let res = await authenticatedFetch('/api/admin/createNewFrame', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!res.ok) return throwError(res);
  return await res.json();
}

export async function updateFrame(frameId, data) {
  let res = await authenticatedFetch(`/api/admin/updateFrame/${frameId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!res.ok) return throwError(res);
}

export async function deleteFrame(frameId) {
  let res = await authenticatedFetch(`/api/admin/deleteFrame/${frameId}`, { method: 'DELETE' });
  if (!res.ok) return throwError(res);
}

export async function pauseFrame(frameId, resumeAtSchedule) {
  let res = await authenticatedFetch(`/api/admin/pauseFrame/${frameId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resumeAtSchedule })
  });
  if (!res.ok) return throwError(res);
}

export async function resumeFrame(frameId) {
  let res = await authenticatedFetch(`/api/admin/resumeFrame/${frameId}`, { method: 'POST' });
  if (!res.ok) return throwError(res);
}

// --- Collections ---

export async function createCollection(payload) {
  let res = await authenticatedFetch('/api/admin/createNewCollection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) return throwError(res);
  return await res.json();
}

export async function updateCollection(collectionId, payload) {
  let res = await authenticatedFetch(`/api/admin/updateCollection/${collectionId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) return throwError(res);
  return await res.json();
}

export async function startIndexing(collectionId) {
  let res = await authenticatedFetch(`/api/admin/startIndexingFirstTime?collection_id=${collectionId}`, {
    method: 'POST'
  });
  if (!res.ok) return throwError(res);
}

export async function listSubDirs(path) {
  let res = await authenticatedFetch(`/api/admin/listSubDirs?path=${encodeURIComponent(path)}`);
  if (!res.ok) return throwError(res);
  return await res.json();
}

/**
 * @param {string} path
 * @returns {Promise<boolean>} true if path exists
 */
export async function validatePath(path) {
  let res = await authenticatedFetch(`/api/admin/listSubDirs?path=${encodeURIComponent(path)}`);
  return res.ok;
}

export async function validateFolderPattern(pattern) {
  let res = await authenticatedFetch('/api/admin/validateFolderPattern', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pattern })
  });
  if (!res.ok) return throwError(res);
  return await res.json();
}

export async function scanForChanges(collectionId) {
  let res = await authenticatedFetch(`/api/admin/scanForChanges/${collectionId}`, { method: 'POST' });
  if (!res.ok) return throwError(res);
}

export async function setAllIntakeStatus(collectionId, status) {
  let res = await authenticatedFetch(`/api/admin/setAllIntakeStatus/${collectionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status })
  });
  if (!res.ok) return throwError(res);
}

export async function setIntakeStatus(collectionId, intakeIndex, status) {
  let res = await authenticatedFetch(`/api/admin/setIntakeStatus/${collectionId}/${intakeIndex}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status })
  });
  if (!res.ok) return throwError(res);
}

// --- Indexer ---

export async function getIndexerStatus() {
  let res = await authenticatedFetch('/api/admin/getIndexerStatus');
  if (!res.ok) return throwError(res);
  return await res.json();
}

export async function getIndexerErrors() {
  let res = await authenticatedFetch('/api/admin/getIndexerErrors');
  if (!res.ok) return throwError(res);
  return await res.json();
}

export async function pauseIndexer() {
  let res = await authenticatedFetch('/api/admin/pauseIndexer', { method: 'PUT' });
  if (!res.ok) return throwError(res);
}

export async function resumeIndexer() {
  let res = await authenticatedFetch('/api/admin/resumeIndexer', { method: 'PUT' });
  if (!res.ok) return throwError(res);
}

export async function updateIndexerConcurrency(value) {
  let res = await authenticatedFetch(`/api/admin/updateIndexerConcurrency/${value}`, { method: 'PUT' });
  if (!res.ok) return throwError(res);
}

// --- Dashboard ---

export async function getDashboardStats() {
  let res = await authenticatedFetch('/api/admin/dashboard/stats');
  if (!res.ok) return throwError(res);
  return await res.json();
}

// --- Jobs ---

export async function getJobs() {
  let res = await authenticatedFetch('/api/admin/jobs');
  if (!res.ok) return throwError(res);
  return await res.json();
}

// --- Config ---

export async function getConfig() {
  let res = await authenticatedFetch('/api/admin/getConfig');
  if (!res.ok) return throwError(res);
  return await res.json();
}

export async function updateConfig(key, value) {
  let res = await authenticatedFetch('/api/admin/updateConfig', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value })
  });
  if (!res.ok) return throwError(res);
}

// --- Collections (admin) ---

export async function getAllCollections() {
  let res = await authenticatedFetch('/api/admin/getAllCollections');
  if (!res.ok) return throwError(res);
  return await res.json();
}
