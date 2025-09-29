import { asyncAll, asyncRun } from "../../database/db-pool.mjs";
import { db } from "../../database/sqlite-database.mjs";

export async function searchForExistingAlbums(searchStr, wantFullName) {
  // sqlite substr is '1' based
  // TODO: Remove hardcoding of 16 - get it from collection.apply_folder_pattern
  // TODO: How to even more generalize it? For e.g. someone may want '<album name> YYYY-MM-DD'
  // note: wantFullName is string (from REST)
  let sql = `
    select ${wantFullName === "true" ? "album" : "trim(substr(album, 16))"} as similar, count(*) cnt
    from metadata 
    where metadata match '{album} : ("${searchStr}"*)'
    and album not like '%TBD%'
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

