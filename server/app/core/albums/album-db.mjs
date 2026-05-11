import { asyncAll, asyncRun } from '#db/db-pool';
import { db } from '#db/sqlite-database';

export async function searchForExistingAlbums(searchStr, wantFullName, collection_id) {
  let sql = `
    select ${wantFullName === "true" ? "album" : "trim(substr(album, 16))"} as similar, count(*) cnt
    from metadata 
    where metadata match '{album} : ("${searchStr}"*)'
    and album not like '%TBD%'
    ${collection_id ? `and collection_id = ${collection_id}` : ''}
    group by 1
    limit 10
  `;

  return await asyncAll(sql);
}

export async function updateAlbum(collection_id, fromAlbum, toAlbum, updateFileName) {
  const sql = `
    update metadata
    set album = @toAlbum
      ${updateFileName ? ", filename = replace(filename, @fromAlbum, @toAlbum)" : ''} 
    where collection_id = @collection_id
    and album = @fromAlbum
  `;

  return await asyncRun(sql, { collection_id, fromAlbum, toAlbum });
}

export function updateAlbumForItems(uuid_arr, toAlbum, updateFileName) {
  // Use transaction for bulk operations - keep using direct db connection
  let stmt = db.prepare(`
    update metadata
    set album = @toAlbum
      ${updateFileName ? ", filename = replace(filename, album, @toAlbum)" : ''} 
    where uuid = @uuid
  `);

  let trans = db.transaction(
    function (uuid_arr, toAlbum, updateFileName) {
      for (let uuid of uuid_arr) {
        stmt.run({ uuid, toAlbum, updateFileName });
      }
    }
  );

  trans(uuid_arr, toAlbum, updateFileName);
}

