// Face recognition operations (name, rename, dismiss, suggestions, search names)

import { authenticatedFetch } from '../authn.mjs';

export async function getFaceSuggestions(clusterId) {
  let res = await authenticatedFetch(`/api/faceSuggestions/${encodeURIComponent(clusterId)}`);
  if (!res.ok) throw await res.json().catch(() => ({ error: { message: `${res.status} ${res.statusText}` } }));
  return await res.json();
}

export async function searchPersonNames(query) {
  let res = await authenticatedFetch(`/api/searchPersonNames?q=${encodeURIComponent(query)}`);
  if (!res.ok) throw await res.json().catch(() => ({ error: { message: `${res.status} ${res.statusText}` } }));
  return await res.json();
}

export async function nameFaceCluster(clusterId, name) {
  let res = await authenticatedFetch(`/api/nameFaceCluster/${encodeURIComponent(clusterId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  if (!res.ok) throw await res.json().catch(() => ({ error: { message: `${res.status} ${res.statusText}` } }));
  return await res.json();
}

export async function updatePersonName(oldName, newName) {
  let res = await authenticatedFetch('/api/updatePersonName', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldName, newName })
  });
  if (!res.ok) throw await res.json().catch(() => ({ error: { message: `${res.status} ${res.statusText}` } }));
  return await res.json();
}

export async function dismissFaceCluster(clusterId) {
  let res = await authenticatedFetch(`/api/dismissFaceCluster/${encodeURIComponent(clusterId)}`, {
    method: 'PUT'
  });
  if (!res.ok) throw await res.json().catch(() => ({ error: { message: `${res.status} ${res.statusText}` } }));
}
