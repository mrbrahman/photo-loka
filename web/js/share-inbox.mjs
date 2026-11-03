// Page-side reader for the PWA share-target inbox.
//
// The service worker (web/sw.mjs) stashes shared files in IndexedDB when the OS
// shares image/video files to Photo-Loka, then redirects into the app. This
// module reads those files back on the upload page and clears the store.
//
// The DB name / store / key MUST stay in sync with the inlined copy in
// web/sw.mjs (the SW is a classic worker and cannot import this module).

const SHARE_DB_NAME = 'photo-loka-share';
const SHARE_STORE = 'inbox';
const SHARE_KEY = 'pending';

function openShareDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SHARE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(SHARE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Atomically read and clear the shared files (if any). Returns an array of File
 * objects (empty if nothing was shared). Reading-and-clearing in one go avoids
 * re-processing the same share on a later reload.
 */
export async function takeSharedFiles() {
  let db;
  try {
    db = await openShareDB();
  } catch (err) {
    return [];
  }
  try {
    const files = await new Promise((resolve, reject) => {
      const tx = db.transaction(SHARE_STORE, 'readwrite');
      const store = tx.objectStore(SHARE_STORE);
      const getReq = store.get(SHARE_KEY);
      getReq.onsuccess = () => {
        store.delete(SHARE_KEY);
        resolve(getReq.result || []);
      };
      getReq.onerror = () => reject(getReq.error);
    });
    return Array.isArray(files) ? files : [];
  } catch (err) {
    return [];
  } finally {
    db.close();
  }
}
