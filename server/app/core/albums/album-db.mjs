import { asyncAll, asyncRun } from '#db/db-pool';
import { db } from '#db/sqlite-database';

/**
 * Search by album_name (FTS-indexed). Optionally filters out albums whose
 * name matches the collection's placeholder (e.g. 'TBD'). When wantFullName
 * is 'true', the result still uses album_name (descriptive only) - the
 * 'full name' concept is from the old denormalized model and no longer
 * applies. We keep the parameter for caller compatibility.
 */
export async function searchForExistingAlbums(searchStr, wantFullName, collection_id, placeholder) {
  const placeholderClause = placeholder
    ? `and album_name not like '%${String(placeholder).replaceAll("'", "''")}%'`
    : '';

  const sql = `
    select album_name as similar, count(*) cnt
    from metadata
    where metadata match '{album_name} : ("${searchStr}"*)'
    ${placeholderClause}
    ${collection_id ? `and collection_id = ${collection_id}` : ''}
    and trim(coalesce(album_name, '')) != ''
    group by 1
    limit 10
  `;

  return await asyncAll(sql);
}

/**
 * Rename all rows in (collection, album_date, fromAlbumName) to use
 * toAlbumName. Also rewrites any nested-album rows where album_name starts
 * with `${fromAlbumName}/`, and rewrites the filename column to reflect the
 * physical folder rename that already happened on disk.
 */
export async function updateAlbum(collection, album_date, fromAlbumName, toAlbumName) {
  // Direct rename of items at the (date, name) bucket.
  const directSql = `
    update metadata
    set album_name = @toAlbumName,
        filename = replace(filename, @fromBase, @toBase)
    where collection_id = @collection_id
    and album_date = @album_date
    and album_name = @fromAlbumName
  `;

  // Nested rename: any row with album_name starting with `${fromAlbumName}/`.
  const nestedSql = `
    update metadata
    set album_name = @toAlbumName || substr(album_name, length(@fromAlbumName) + 1),
        filename = replace(filename, @fromBase, @toBase)
    where collection_id = @collection_id
    and album_date = @album_date
    and album_name like @fromPrefix
  `;

  // The "base" path components used for filename string-replacement. We only
  // know the rename was applied to the leaf (one folder), so we replace just
  // the matching segment in the path.
  // For example: '.../2021-01-01 New Year/...' -> '.../2021-01-01 Birthday/...'
  // We compute a stable string to replace by relying on the format
  // function elsewhere, but for the in-DB replace we can match on the
  // descriptive segment within the path.
  // NOTE: this is a string-level replace; if `fromAlbumName` happens to
  // appear elsewhere in the filename (e.g. as a substring of an unrelated
  // basename), we'd over-replace. In practice this is very unlikely for
  // typical photo paths. If it becomes an issue we can compute the exact
  // old/new sub-paths via the pattern engine and pass them in.
  const fromBase = ` ${fromAlbumName}`;       // matches the leading space + name in the folder
  const toBase   = toAlbumName ? ` ${toAlbumName}` : '';

  await asyncRun(directSql, {
    collection_id: collection.collection_id,
    album_date,
    fromAlbumName,
    toAlbumName,
    fromBase,
    toBase
  });

  await asyncRun(nestedSql, {
    collection_id: collection.collection_id,
    album_date,
    fromAlbumName,
    toAlbumName,
    fromBase,
    toBase,
    fromPrefix: `${fromAlbumName}/%`
  });
}

/**
 * Update album_date and album_name for a list of moved items. The movePlan
 * carries per-item destination paths in the same order as uuid_arr (built
 * that way by album-manager), so we update filename to the new path while
 * setting the new album fields.
 */
export function updateAlbumForItems(collection, uuid_arr, target_album_date, target_album_name, movePlan) {
  const stmt = db.prepare(`
    update metadata
    set album_date = @album_date,
        album_name = @album_name,
        filename = @filename
    where uuid = @uuid
  `);

  const trans = db.transaction(function (uuid_arr, movePlan) {
    for (let i = 0; i < uuid_arr.length; i++) {
      stmt.run({
        uuid: uuid_arr[i],
        album_date: target_album_date,
        album_name: target_album_name,
        filename: movePlan[i].dest
      });
    }
  });

  trans(uuid_arr, movePlan);
}
