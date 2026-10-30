// Collections summary (lightweight, for app-shell collection switching)

import { authenticatedFetch } from '../authn.mjs';
import { apiUrl } from '../api-base.mjs';

export async function getCollections() {
  let res = await authenticatedFetch(apiUrl('/api/collections'));
  if (!res.ok) throw await res.json().catch(() => ({ error: { message: `${res.status} ${res.statusText}` } }));
  return await res.json();
}
