import { db } from './sqlite-database.mjs';

export const restrictSearchCols = ['album', 'keywords', 'faces', 'objects', 'mediatype', 'make', 'model', 'geo_address'];

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
  l: 'logical'
}

function converToFilterStr(searchStr){
  /*
    Features:
    1. When multiple conditions are prsent, by default they are "AND"ed.
        e.g. album:trip camera:samsung type:video
        will translate as
        {album}: "trip"* AND {camera}: "samsung"* AND {type}: "video"*
    2. This can be overwritten using the "logical" or "l" input. E.g. l:or
    3. The input from "logical" keyword applies to all conditions
        e.g. album:trip camera:samsung type:video l:or
        will translate as
        {album}: "trip"* OR {camera}: "samsung"* OR {type}: "video"*
    4. Any un-prefixed condition will be applied to all search-enabled columns
       in the restrictSearchCols array
    5. For advanced needs (including querying non restricted columns - for e.g. file_date), use the "raw"
       input using SQLite FTS syntax. Thich will be used as-is in the filter.
        e.g. 
          raw:"metadata match '{album}: (states* AND trip*)'"
          raw:"strftime('%W',file_date)=strftime('%W',date()) and strftime('%Y',file_date) != strftime('%Y',date())" --> all 'past' photos of current week
    6. "raw" can be clubbled with other filters, if needed
  
    TODO: implement faces (array columns) OR, AND and ONLY conditions
  */

  // split appropriately by space (considering space inside of a string), and split into array
  let filterItems = searchStr.replaceAll(/\s+(?=(?:(?:[^"]*"){2})*[^"]*"[^"]*$)/g, "__s_p_a_c_e__").split(/\s+/).map(x=>x.replaceAll(/__s_p_a_c_e__/g, ' '));
  
  let filterKeyVal = filterItems.map(x=>{
    let [first, ...rest] = x.split(':');
    if(rest.length>0){
      return [first, rest.join(':')];
    }
    else {
      return [first]
    }
  });

  let strip = (s) => s.replace(/(^"|"$)/g, '');
  

  let logical='AND', ftsFilters=[], otherFilters=[];
  for (let f of filterKeyVal) {
    let col = (aliases[f[0]] || f[0]).toLowerCase();
    let filterStr = (f[1] && strip(f[1])) || null;
    
    if (f.length == 1){
      // search across all allowed columns
      ftsFilters.push(`{${restrictSearchCols.join(' ')}} : ( "${strip(f[0])}"* )`);
    }
    else if(col == 'logical'){
      logical = filterStr.toUpperCase();
    }
    else if(col == 'rating'){
      otherFilters.push(`rating = ${f[1]}`)
    }
    else if(col == 'uuid'){
      otherFilters.push(`uuid = '${filterStr}'`)
    }
    else if (col == "raw"){
      otherFilters.push(filterStr);
    }
    else if(restrictSearchCols.includes(col)){
      // TODO: handle , (and) | (or) & (only)
      // "only" is appliable only for array data
      
      ftsFilters.push(`{${col}} : ( "${filterStr}"* )`)
    }
    else {
      // ignore everything else
    }
  }

  let allFtsFilters = ftsFilters.length > 0 ? `metadata match '${ftsFilters.join(` ${logical} `)}'` : '';
  let allOtherFilters = otherFilters.join(` ${logical} `)

  let allFilters = [allFtsFilters, allOtherFilters].filter(x=>x);

  let final = `( ${allFilters.join(` ${logical} `)} )`;
  return final;

}

export function runSearch(collection_id, searchStr, trashed = false, groupByAlbum = true) {
  let filters = [], limit = false;
  
  filters.push(`coalesce(trashed, false) = ${trashed}`);

  if(collection_id)
    filters.push(`collection_id = ${collection_id}`);

  if(searchStr){
    let parsedCondition = converToFilterStr(searchStr);
    console.log(parsedCondition);

    filters.push(parsedCondition)
  } else {
    limit = true;
  }
  // console.log(filters)

  const baseQuery = `
    select album,
      --aspectratio, uuid, mediatype, coalesce(rating,0) as rating, file_date,
      json_object(
        'data', 
          json_object(
            'ar', aspectratio,
            'id', uuid,
            'type', mediatype,
            'rating', coalesce(rating,0)
          )
      ) as item
    from metadata
    where ${filters.join(' and ')}
    and mediatype in ('image', 'video')  -- TODO: add audio
    order by album desc, datetime(file_date)
  `;

  let sql;
  if (groupByAlbum) {
    sql = `
      with t as (${baseQuery})
      select album, json_group_array(json(item)) as items 
      from t
      group by album
      order by album desc
      ${limit ? 'limit 300' : ''}
    `;
  } else {
    sql = `
      with t as (${baseQuery})
      select item
      from t
      ${limit ? 'limit 300' : ''}
    `;
  }

  console.log(sql)
  var stmt = db.prepare(sql)
  
  let results = stmt.all();
  return groupByAlbum ? transformSearchResultsFromDb(results) : results.map(row => JSON.parse(row.item));
}

function transformSearchResultsFromDb(rows){
  return rows.map(row=>{
    row['items'] = JSON.parse(row['items']);
    row['id'] = row['album'].replace(/[\s&\/]/ig, '_');
    return row
  });
}

export function searchForExistingAlbums(searchStr, wantFullName){
  // sqlite substr is '1' based
  // TODO: Remove hardcoding of 16 - get it from collection.apply_folder_pattern
  // TODO: How to even more generalize it? For e.g. someone may want '<album name> YYYY-MM-DD'
  
  // note: wantFullName is string (from REST)
  let sql = `
    select ${wantFullName==="true"?"album":"trim(substr(album, 16))"} as similar, count(*) cnt
    from metadata 
    where metadata match '{album} : ("${searchStr}"*)'
    and album not like '%TBD%'
    group by 1
    limit 10
  `;

  var stmt = db.prepare(sql);
  return stmt.all();
}

export function getGpsCoordinates(){
  let sql = `
    select 
      round(gps_lat, 4) as lat,
      round(gps_long, 4) as lng,
      count(*) as count
    from metadata
    where gps_lat is not null 
    and gps_long is not null
    and coalesce(trashed, false) = false
    and mediatype in ('image', 'video')
    group by 1, 2
  `;
  
  var stmt = db.prepare(sql);
  return stmt.all();
}

export function searchByGpsCoordinates(collection_id, coordinates, trashed = false) {
  let coordFilters = coordinates.map(coord => 
    `(${coord.lat}, ${coord.lng})`
  ).join(', ');
  
  let searchStr = `raw:"(round(gps_lat,4), round(gps_long, 4)) in (${coordFilters})"`;
  return runSearch(collection_id, searchStr, trashed, false);
}

