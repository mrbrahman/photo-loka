// Collections summary (lightweight, for app-shell collection switching)

import { authenticatedFetch } from '../authn.mjs';

export async function getCollections() {
  let res = await authenticatedFetch('/api/collections');
  if (!res.ok) throw await res.json().catch(() => ({ error: { message: `${res.status} ${res.statusText}` } }));
  return await res.json();
}
