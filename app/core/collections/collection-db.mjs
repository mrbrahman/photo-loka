import { asyncGet, asyncAll, asyncRun } from '#db/db-pool';
import { createLogger } from '#utils/logger';

const logger = createLogger(import.meta.url);

function transformEntryToDb(row){
  // make a copy of the object, don't change the original
  let tRow = Object.assign({}, row);
  ['listen_paths'].map(c=>{
    tRow[c] = JSON.stringify(tRow[c])
  });
  return tRow;
}

function transformEntryFromDb(row){
  ['listen_paths'].map(c=>{
    row[c] = JSON.parse(row[c])
  })
  return row;
}

export async function createNewCollection(entry){
  const info = await asyncRun(`
    insert into collections
    (collection_name, collection_path, album_type, listen_paths, apply_folder_pattern, default_collection)
    values
    (@collection_name, @collection_path, @album_type, json(@listen_paths), @apply_folder_pattern, @default_collection)
  `, transformEntryToDb(entry));
  return info.lastInsertRowid;
}

export async function getAllCollections(){
  // convert listen_paths back to JavaScript Array
  const output = await asyncAll(`
    select collection_id, collection_name, collection_path, album_type,
      listen_paths, apply_folder_pattern, default_collection
    from collections
  `);
  return output.map(transformEntryFromDb)
}

export async function getCollection(collection_id){
  // convert listen_paths back to JavaScript Array
  const output = await asyncGet(`
    select collection_id, collection_name, collection_path, album_type,
      listen_paths, apply_folder_pattern, default_collection, trash_days
    from collections where collection_id = ?
  `, collection_id);
  return transformEntryFromDb(output);
}

export async function getDefaultCollection(){
  // convert listen_paths back to JavaScript Array
  const output = await asyncGet(`
    select collection_id, collection_name, collection_path, album_type,
      listen_paths, apply_folder_pattern, default_collection
    from collections where default_collection = 1
  `);
  return transformEntryFromDb(output);
}

export function updateDefaultCollection(entries){
  // TODO
  logger.warn("TODO :-)")
}
