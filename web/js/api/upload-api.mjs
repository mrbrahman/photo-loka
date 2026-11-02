// UI file-upload API: create a staging session, upload files one at a time
// (with byte progress via XHR), then finalize to trigger intake.
//
// createUploadSession/finalizeUpload are plain JSON and use authenticatedFetch.
// uploadFile needs XMLHttpRequest because fetch does not expose upload progress
// events (xhr.upload.onprogress), so it attaches the bearer token itself and
// retries once on a 401 after refreshing the token.

import { authenticatedFetch, getToken, refreshToken, clearToken } from '../authn.mjs';

// Create a new upload session for a collection. Returns the opaque session_id.
export async function createUploadSession(collectionId) {
  let res = await authenticatedFetch('/api/createUploadSession', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ collection_id: collectionId })
  });
  if (!res.ok) throw await res.json().catch(() => ({ error: { message: `${res.status} ${res.statusText}` } }));
  let data = await res.json();
  return data.session_id;
}

// Finalize the session: the server hands the staging dir to the intake flow.
export async function finalizeUpload(sessionId) {
  let res = await authenticatedFetch('/api/finalizeUpload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId })
  });
  if (!res.ok) throw await res.json().catch(() => ({ error: { message: `${res.status} ${res.statusText}` } }));
}

/**
 * Upload a single file into the given session with byte-level progress.
 *
 * @param {string} sessionId  opaque session id from createUploadSession
 * @param {File} file         the File to upload
 * @param {object} [opts]
 * @param {(loaded:number, total:number)=>void} [opts.onProgress] progress callback
 * @param {(xhr:XMLHttpRequest)=>void} [opts.onXhr] receives the XHR (for abort)
 * @returns {Promise<void>} resolves when the file is stored server-side
 */
export function uploadFile(sessionId, file, opts = {}) {
  return sendWithRetry(sessionId, file, opts, true);
}

// sendWithRetry performs one XHR upload; on a 401 it refreshes the token once
// and retries (allowRetry=false on the second attempt to avoid a loop).
function sendWithRetry(sessionId, file, opts, allowRetry) {
  return new Promise((resolve, reject) => {
    const url = `/api/uploadFile?session_id=${encodeURIComponent(sessionId)}`;
    const form = new FormData();
    form.append('file', file, file.name);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Authorization', `Bearer ${getToken()}`);

    if (opts.onProgress) {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) opts.onProgress(e.loaded, e.total);
      });
    }

    xhr.addEventListener('load', async () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      if (xhr.status === 401 && allowRetry) {
        try {
          await refreshToken();
          // Retry once with the refreshed token.
          resolve(sendWithRetry(sessionId, file, opts, false));
        } catch (err) {
          clearToken();
          reject(new Error('Session expired'));
        }
        return;
      }
      reject(parseXhrError(xhr));
    });

    xhr.addEventListener('error', () => reject(new Error('Network error during upload')));
    xhr.addEventListener('abort', () => reject(new Error('Upload aborted')));

    if (opts.onXhr) opts.onXhr(xhr);

    xhr.send(form);
  });
}

function parseXhrError(xhr) {
  try {
    const body = JSON.parse(xhr.responseText);
    if (body?.error?.message) return new Error(body.error.message);
  } catch (e) {
    // response was not JSON
  }
  return new Error(`Upload failed (${xhr.status})`);
}
