import { asyncGet, asyncAll } from '#db/db-pool';

// Single scan of metadata table to get all summary stats
export async function getLibraryStats() {
  return await asyncGet(`
    select
      count(*) filter (where coalesce(trashed, 0) = 0) as totalItems,
      coalesce(sum(filesize) filter (where coalesce(trashed, 0) = 0), 0) as totalSize,
      count(distinct album_date || '|' || coalesce(album_name, '')) filter (where coalesce(trashed, 0) = 0) as albums,
      count(*) filter (where coalesce(trashed, 0) = 1) as trashedItems,
      count(*) filter (where coalesce(trashed, 0) = 0 and mediatype = 'image') as imageCount,
      coalesce(sum(filesize) filter (where coalesce(trashed, 0) = 0 and mediatype = 'image'), 0) as imageSize,
      count(*) filter (where coalesce(trashed, 0) = 0 and mediatype = 'video') as videoCount,
      coalesce(sum(filesize) filter (where coalesce(trashed, 0) = 0 and mediatype = 'video'), 0) as videoSize,
      count(*) filter (where coalesce(trashed, 0) = 0 and mediatype = 'audio') as audioCount,
      coalesce(sum(filesize) filter (where coalesce(trashed, 0) = 0 and mediatype = 'audio'), 0) as audioSize,
      count(*) filter (where coalesce(trashed, 0) = 0 and mediatype not in ('image', 'video', 'audio')) as otherCount,
      coalesce(sum(filesize) filter (where coalesce(trashed, 0) = 0 and mediatype not in ('image', 'video', 'audio')), 0) as otherSize
    from metadata
  `);
}

export async function getCollectionStats() {
  return await asyncAll(`
    select
      c.collection_id,
      c.collection_name,
      c.collection_path,
      count(m.uuid) as items,
      coalesce(sum(m.filesize), 0) as totalSize
    from collections c
    left join metadata m on m.collection_id = c.collection_id and coalesce(m.trashed, 0) = 0
    group by c.collection_id
  `);
}
