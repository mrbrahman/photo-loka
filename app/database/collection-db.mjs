import { db } from './sqlite-database.mjs';

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

export function createNewCollection(entry){
  var stmt = db.prepare(`
    insert into collections
    (collection_name, collection_path, album_type, listen_paths, apply_folder_pattern, default_collection)
    values
    (@collection_name, @collection_path, @album_type, json(@listen_paths), @apply_folder_pattern, @default_collection)
  `);

  let info = stmt.run( transformEntryToDb(entry)) ;
  return info.lastInsertRowid;
}

export function getAllCollections(){
  // convert listen_paths back to JavaScript Array
  var stmt = db.prepare(`
    select collection_id, collection_name, collection_path, album_type,
      listen_paths, apply_folder_pattern, default_collection
    from collections
  `)
  let output = stmt.all();
  return output.map(transformEntryFromDb)
}

export function getCollection(collection_id){
  // convert listen_paths back to JavaScript Array
  var stmt = db.prepare(`
    select collection_id, collection_name, collection_path, album_type,
      listen_paths, apply_folder_pattern, default_collection, trash_path
    from collections where collection_id = ?
  `)
  let output = stmt.get(collection_id);
  return transformEntryFromDb(output);
}

export function getDefaultCollection(){
  // convert listen_paths back to JavaScript Array
  var stmt = db.prepare(`
    select collection_id, collection_name, collection_path, album_type,
      listen_paths, apply_folder_pattern, default_collection
    from collections where default_collection = 1
  `)
  let output = stmt.get();
  return transformEntryFromDb(output);
}

export function updateDefaultCollection(entries){
  // TODO
  console.log("TODO :-)")
}
