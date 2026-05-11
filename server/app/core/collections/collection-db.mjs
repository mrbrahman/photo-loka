import { asyncGet, asyncAll, asyncRun } from '#db/db-pool';
import { createLogger } from '#utils/logger';

const logger = createLogger(import.meta.url);

function transformEntryToDb(row){
  // make a copy of the object, don't change the original
  let tRow = Object.assign({}, row);
  ['intake_configs'].map(c=>{
    tRow[c] = JSON.stringify(tRow[c])
  });
  return tRow;
}

function transformEntryFromDb(row){
  ['intake_configs'].map(c=>{
    row[c] = JSON.parse(row[c])
  })
  return row;
}

export async function createNewCollection(entry){
  const info = await asyncRun(`
    insert into collections
    (collection_name, collection_path, album_type, intake_configs, apply_folder_pattern, default_collection)
    values
    (@collection_name, @collection_path, @album_type, json(@intake_configs), @apply_folder_pattern, @default_collection)
  `, transformEntryToDb(entry));
  return info.lastInsertRowid;
}

export async function getAllCollections(){
  // convert intake_configs back to JavaScript Array
  const output = await asyncAll(`
    select collection_id, collection_name, collection_path, album_type,
      intake_configs, apply_folder_pattern, default_collection
    from collections
  `);
  return output.map(transformEntryFromDb)
}

export async function getCollection(collection_id){
  // convert intake_configs back to JavaScript Array
  const output = await asyncGet(`
    select collection_id, collection_name, collection_path, album_type,
      intake_configs, apply_folder_pattern, default_collection, trash_days
    from collections where collection_id = ?
  `, collection_id);
  return transformEntryFromDb(output);
}

export async function getCollectionsSummary(){
  return await asyncAll(`
    select collection_id, collection_name, default_collection, apply_folder_pattern
    from collections
  `);
}

export async function getDefaultCollection(){
  // convert intake_configs back to JavaScript Array
  const output = await asyncGet(`
    select collection_id, collection_name, collection_path, album_type,
      intake_configs, apply_folder_pattern, default_collection
    from collections where default_collection = 1
  `);
  return transformEntryFromDb(output);
}

export async function getCollectionByIntakePath(dirPath){
  const output = await asyncGet(`
    select collection_id, collection_name, collection_path, album_type,
      intake_configs, apply_folder_pattern, default_collection, trash_days
    from collections, json_each(intake_configs)
    where json_extract(value, '$.path') = ?
  `, dirPath);
  return output ? transformEntryFromDb(output) : null;
}

export async function updateCollection(collection_id, entry){
  await asyncRun(`
    update collections set
      collection_name = @collection_name,
      album_type = @album_type,
      intake_configs = json(@intake_configs),
      apply_folder_pattern = @apply_folder_pattern,
      default_collection = @default_collection,
      trash_days = @trash_days
    where collection_id = @collection_id
  `, { collection_id, ...transformEntryToDb(entry) });
}

export function updateDefaultCollection(entries){
  // TODO
  logger.warn("TODO :-)")
}

export async function setIntakeStatusByIndex(collection_id, intakeIndex, status) {
  await asyncRun(`
    update collections
    set intake_configs = json_set(intake_configs, '$[' || cast(@intakeIndex as integer) || '].status', @status)
    where collection_id = @collection_id
  `, { collection_id, intakeIndex, status });
}

export async function setAllIntakeStatusForCollection(collection_id, status) {
  await asyncRun(`
    update collections
    set intake_configs = (
      select json_group_array(
        case
          when json_extract(value, '$.method') != 'on-demand'
          then json_set(value, '$.status', @status)
          else value
        end
      )
      from json_each(intake_configs)
    )
    where collection_id = @collection_id
  `, { collection_id, status });
}

export async function setIntakeStatusByMethod(method, status) {
  await asyncRun(`
    update collections
    set intake_configs = (
      select json_group_array(
        case
          when json_extract(value, '$.method') = @method
          then json_set(value, '$.status', @status)
          else value
        end
      )
      from json_each(intake_configs)
    )
    where exists (
      select 1 from json_each(intake_configs)
      where json_extract(value, '$.method') = @method
    )
  `, { method, status });
}
