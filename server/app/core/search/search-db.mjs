import { asyncGet, asyncAll, asyncRun } from '#db/db-pool';
import { createLogger } from '#utils/logger';

const logger = createLogger(import.meta.url);

// Columns indexed in the porter FTS table (stemmed, NLP-style search)
const textCols = ['album_name', 'description', 'keywords'];

// Columns indexed in the unicode FTS table (exact token match)
const metaCols = ['filename', 'mimetype', 'mediatype', 'faces', 'make', 'model', 'geo_address', 'album_date'];

// All FTS-searchable columns (union of both tables)
export const restrictSearchCols = [...textCols, ...metaCols];

// aliases: the right side (realCol) can also be known by the left side (alias)
export const aliases = {
  tags: 'keywords',
  people: 'faces',
  name: 'faces',
  face: 'faces',
  loc: 'geo_address',
  location: 'geo_address',
  address: 'geo_address',
  camera: 'model',
  type: 'mediatype',
  desc: 'description',
  album: 'album_name',  // legacy 'album:' search prefix maps to album_name
  date: 'album_date',
  l: 'logical'
}

// The search view name and its FTS MATCH handles
// (View dropped - using subquery pattern instead for simpler explain plans)

// FTS table names (used for subquery pattern)
const FTS_PORTER_TABLE = 'metadata_fts_porter';
const FTS_UNICODE_TABLE = 'metadata_fts_unicode';

function getColTable(col) {
  if (textCols.includes(col)) return 'text';
  if (metaCols.includes(col)) return 'meta';
  return null;
}

function converToFilterStr(searchStr){
  /*
    Features:
    1. When multiple conditions are present, by default they are "AND"ed.
        e.g. album_name:trip camera:samsung type:video
        will translate as
        rowid IN (SELECT rowid FROM metadata_fts_porter WHERE ... MATCH '{album_name} : ("trip")')
        AND rowid IN (SELECT rowid FROM metadata_fts_unicode WHERE ... MATCH '{make} : ("samsung"*) AND {mediatype} : ("video"*)')
    2. This can be overwritten using the "logical" or "l" input. E.g. l:or
    3. The input from "logical" keyword applies to all conditions.
        e.g. album_name:trip camera:samsung type:video l:or
        will translate as
        rowid IN (SELECT rowid FROM metadata_fts_porter WHERE ... MATCH '{album_name} : ("trip")')
        OR rowid IN (SELECT rowid FROM metadata_fts_unicode WHERE ... MATCH '{make} : ("samsung"*) OR {mediatype} : ("video"*)')
    4. Any un-prefixed condition will be applied to all search-enabled columns
       across both FTS tables (OR across tables).
        e.g. hike
        will translate as
        (rowid IN (SELECT rowid FROM metadata_fts_porter WHERE ... MATCH '"hike"')
         OR rowid IN (SELECT rowid FROM metadata_fts_unicode WHERE ... MATCH '"hike"*'))
    5. For advanced needs, use the "raw" input. This will be used as-is in the filter.
        e.g. 
          raw:"strftime('%W',captured_at)=strftime('%W',date()) and strftime('%Y',captured_at) != strftime('%Y',date())"
          --> all 'past' photos of current week
    6. "raw" can be combined with other filters, if needed.
  
    TODO: implement faces (array columns) OR, AND and ONLY conditions
  */

  // split appropriately by space (considering space inside of a string), and split into array
  let filterItems = searchStr.replaceAll(/\s+(?=(?:(?:[^"]*"){2})*[^"]*"[^"]*$)/g, "__s_p_a_c_e__").split(/\s+/).map(x=>x.replaceAll(/__s_p_a_c_e__/g, ' '));
  
  let filterKeyVal = filterItems.map(x=>{
    let [first, ...rest] = x.split(':');
    if(rest.length>0){
      return [first.toLowerCase(), rest.join(':')];
    }
    else {
      return [first]
    }
  });

  let strip = (s) => s.replace(/(^"|"$)/g, '');

  let logical='AND', textFilters=[], metaFilters=[], broadFilters=[], otherFilters=[];
  for (let f of filterKeyVal) {
    let col = (aliases[f[0]] || f[0]).toLowerCase();
    let filterStr = (f[1] && strip(f[1])) || null;
    
    if (f.length == 1){
      // Un-prefixed: search across all columns in both FTS tables (OR across tables)
      let term = strip(f[0]);
      broadFilters.push(term);
    }
    else if(col == 'logical'){
      logical = filterStr.toUpperCase();
    }
    else if(col == 'rating'){
      otherFilters.push(`rating = ${f[1]}`)
    }
    else if(col == 'private'){
      otherFilters.push(`coalesce(is_private, 0) = ${filterStr.toLowerCase() === 'true' ? 1 : 0}`)
    }
    else if(col == 'uuid'){
      otherFilters.push(`uuid = '${filterStr}'`)
    }
    else if (col == "raw"){
      otherFilters.push(filterStr);
    }
    else if(restrictSearchCols.includes(col)){
      // Route to the correct FTS bucket
      let table = getColTable(col);
      if (table === 'text') {
        textFilters.push(`{${col}} : ( "${filterStr}" )`);
      } else if (table === 'meta') {
        metaFilters.push(`{${col}} : ( "${filterStr}"* )`);
      }
    }
    else {
      // ignore everything else
    }
  }

  // Build the FTS filter clause(s)
  let ftsClause = buildFtsClause(textFilters, metaFilters, broadFilters, logical);
  let allOtherFilters = otherFilters.join(` ${logical} `);

  let allFilters = [ftsClause, allOtherFilters].filter(x=>x);
  let final = allFilters.length > 0 ? `( ${allFilters.join(` ${logical} `)} )` : '';
  return final;
}

function buildFtsClause(textFilters, metaFilters, broadFilters, logical) {
  // broadFilters: un-prefixed terms that should match in EITHER FTS table (OR across tables)
  // textFilters: column-prefixed terms routed to porter FTS
  // metaFilters: column-prefixed terms routed to unicode FTS

  let parts = [];

  // Handle broad (un-prefixed) terms: always OR across both tables
  if (broadFilters.length > 0) {
    let porterExpr = broadFilters.map(t => `"${t}"`).join(` ${logical} `);
    let unicodeExpr = broadFilters.map(t => `"${t}"*`).join(` ${logical} `);
    let textMatch = `rowid IN (SELECT rowid FROM ${FTS_PORTER_TABLE} WHERE ${FTS_PORTER_TABLE} MATCH '${porterExpr}')`;
    let metaMatch = `rowid IN (SELECT rowid FROM ${FTS_UNICODE_TABLE} WHERE ${FTS_UNICODE_TABLE} MATCH '${unicodeExpr}')`;
    parts.push(`(${textMatch} OR ${metaMatch})`);
  }

  // Handle column-prefixed terms routed to porter FTS
  if (textFilters.length > 0) {
    let matchExpr = textFilters.join(` ${logical} `);
    parts.push(`rowid IN (SELECT rowid FROM ${FTS_PORTER_TABLE} WHERE ${FTS_PORTER_TABLE} MATCH '${matchExpr}')`);
  }

  // Handle column-prefixed terms routed to unicode FTS
  if (metaFilters.length > 0) {
    let matchExpr = metaFilters.join(` ${logical} `);
    parts.push(`rowid IN (SELECT rowid FROM ${FTS_UNICODE_TABLE} WHERE ${FTS_UNICODE_TABLE} MATCH '${matchExpr}')`);
  }

  if (parts.length === 0) return '';
  return parts.join(` ${logical} `);
}

function orderByClause(inp) {
  // Used for the flat (non-grouped) path, e.g. frame manager. Day-grouped
  // queries override this with their own ordering. captured_at is the per-item
  // capture time; coalesce-to-0 puts no-time items at the end of any sort.
  const defaultClause = 'order by album_date desc, datetime(captured_at) desc';
  if(!inp) return defaultClause;

  if(inp.toLowerCase() === 'asc') return 'order by datetime(captured_at) asc';
  if(inp.toLowerCase() === 'desc') return 'order by datetime(captured_at) desc';
  if(inp.toLowerCase() === 'random') return 'order by random()';

  return defaultClause;
}

export async function runSearch(collection_id, searchStr, trashed = false, isPrivate = false, groupByDay = true, orderBy = null, dateRange = null){
  let filters = [], limit = false;
  
  filters.push(`coalesce(is_trashed, 0) = ${trashed ? 1 : 0}`);

  // only apply default private filter if not explicitly searching for private items
  let hasExplicitPrivateFilter = searchStr && /(?:^|\s)private:/i.test(searchStr);
  if (!hasExplicitPrivateFilter) {
    filters.push(`coalesce(is_private, 0) = ${isPrivate ? 1 : 0}`);
  }

  if(collection_id)
    filters.push(`collection_id = ${collection_id}`);

  if(searchStr){
    let parsedCondition = converToFilterStr(searchStr);
    logger.debug(parsedCondition);

    if(parsedCondition) {
      filters.push(parsedCondition);
    }
  } else {
    limit = true;
  }

  // Optional date-range filter (used by /getAll to default to the last year).
  // album_date is a YYYY-MM-DD string column, so direct string comparison
  // works without timezone normalization.
  if (dateRange?.fromDate) {
    filters.push(`album_date >= '${dateRange.fromDate}'`);
  }
  if (dateRange?.toDate) {
    filters.push(`album_date <= '${dateRange.toDate}'`);
  }

  // Item JSON shape (used by both grouped and flat paths):
  //   { albumDate, albumName, data: { ar, id, type, rating, dur, hasGps,
  //     hasDesc, hasTags, private, t, hasTime } }
  // - albumDate: YYYY-MM-DD; the day this item belongs to in the timeline.
  // - albumName: descriptive part only (e.g. 'New Year' or 'New Year/Subfolder').
  // - t: unix epoch seconds derived from captured_at, or 0 when null.
  // - hasTime: 1 if captured_at is non-null (real EXIF capture time), 0 if it
  //   was a fallback (mtime / null). No-time items render at end of day.
  const itemSelect = `
    json_object(
      'albumDate', album_date,
      'albumName', coalesce(album_name, ''),
      'data', json_object(
        'ar', round(aspectratio, 2),
        'id', uuid,
        'type', mediatype,
        'rating', coalesce(rating,0),
        'dur',
          case
            when duration >= 3600 then
              cast(duration/3600 as int) || ':' || substr('0' || cast((duration % 3600)/60 as int), -2) || ':' || substr('0' || cast(duration % 60 as int), -2)
            when duration is not null then
              cast(duration/60 as int) || ':' || substr('0' || cast(duration % 60 as int), -2)
          end,
        'hasGps', case when gps_lat is not null then 1 else 0 end,
        'hasDesc', case when trim(coalesce(description,'')) not in ('', 'null') then 1 else 0 end,
        'hasTags', case when trim(coalesce(keywords,'')) not in ('', 'null', '[null]') then 1 else 0 end,
        'private', case when coalesce(is_private, 0) = 1 then 1 else 0 end,
        't', coalesce(unixepoch(captured_at), 0),
        'hasTime', case when captured_at is not null then 1 else 0 end
      )
    )
  `;

  let sql;
  if (groupByDay) {
    // Day grouping: items within a day are ordered by datetime DESC of
    // captured_at (timed items first newest -> oldest; null captured_at coalesces
    // to 0 and falls to the end). album_name + filename used as
    // tiebreakers and to cluster no-time items by album.
    sql = `
      with t as (
        select
          album_date as day,
          ${itemSelect} as item
        from metadata
        where ${filters.join(' and ')}
        and mediatype in ('image', 'video')
        order by album_date desc,
                 coalesce(unixepoch(captured_at), 0) desc,
                 album_name asc, filename asc
      )
      select day, json_group_array(json(item)) as items
      from t
      group by day
      order by day desc
      ${limit ? 'limit 365' : ''}
    `;
  } else {
    sql = `
      select album_name, ${itemSelect} as item
      from metadata
      where ${filters.join(' and ')}
      and mediatype in ('image', 'video')
      ${orderByClause(orderBy)}
      ${limit ? 'limit 300' : ''}
    `;
  }

  logger.info(sql)
  
  let results = await asyncAll(sql);
  return groupByDay ? transformDayGrouped(results) : transformFlat(results);
}

function transformDayGrouped(rows){
  return rows.map(row => ({
    day: row.day,
    items: JSON.parse(row.items)
  }));
}

function transformFlat(rows){
  return rows.map(row => ({
    album: row.album_name,
    item: JSON.parse(row.item)
  }));
}

export async function getItemInfo(uuid){
  let sql = `
    select 
      uuid, album_date, album_name, filename,
      description, filesize, ext, mimetype, mediatype,
      keywords, faces, rating,
      image_width, image_height, duration,
      make, model,
      gps_lat, gps_lng, gps_alt, geo_address,
      captured_at, file_modified_at,
      indexed_at, trashed_at,
      (select json_group_array(json_object(
        'face_idx', fr.face_idx,
        'cluster_id', fr.cluster_id,
        'person_name', fr.person_name,
        'confidence', fr.confidence,
        'gender', fr.gender,
        'age', fr.age
      )) from face_recognition fr where fr.uuid = metadata.uuid
        and fr.cluster_id not in (select cluster_id from face_dismissed_clusters)
      ) as face_details
    from metadata
    where uuid = ?
  `;
  return await asyncGet(sql, uuid);
}

export async function getGpsCoordinates(collection_id){
  let sql = `
    select 
      round(gps_lat, 4) as lat,
      round(gps_lng, 4) as lng,
      count(*) as count
    from metadata
    where gps_lat is not null 
    and gps_lng is not null
    and coalesce(is_trashed, 0) = 0
    and coalesce(is_private, 0) = 0
    and mediatype in ('image', 'video')
    ${collection_id ? `and collection_id = ${collection_id}` : ''}
    group by 1, 2
  `;
  
  return await asyncAll(sql);
}

export async function searchByGpsCoordinates(collection_id, bounds, trashed = false) {
  let searchStr = `raw:"round(gps_lat, 4) between ${bounds.sw.lat} and ${bounds.ne.lat} and round(gps_lng, 4) between ${bounds.sw.lng} and ${bounds.ne.lng}"`;
  return await runSearch(collection_id, searchStr, trashed, false, true);
}
