import * as fs from 'fs';
import * as path from 'path';

import * as watcher from '../../infrastructure/file-watcher.mjs';
import * as db from './collection-db.mjs';

export async function createNewCollection(record){
  if(!isValidDir(record.collection_path)){
    throw `${record.collection_path} is not a valid path in collection path`
  }

  for (let path of record.listen_paths){
    if(!isValidDir(path)){
      throw `${path} is not a valid path in listen path`
    }
  }

  let albumTypes = ['FOLDER_ALBUM','VIRTUAL_ALBUM']
  if(albumTypes.indexOf(record.album_type)<0){
    throw `${record.album_type} is invalid album type. Valid values are: ${albumTypes.join(', ')}`
  }
  
  let id = await db.createNewCollection(record);
  watcher.startWatcherForCollection({collection_id: id, ...record});
  
  return id;
} 

export async function getAllCollections(){
  return await db.getAllCollections()
}

export async function getDefaultCollection(){
  return await db.getDefaultCollection()
}

export async function getCollection(collection_id){
  return await db.getCollection(collection_id)
}

export function isValidDir(path){
  return fs.existsSync(path) && fs.lstatSync(path).isDirectory()
}

export function listSubDirs(dir){
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(x => x.isDirectory())
    .map(x => x.name)
}

export async function getFileCount(collection_id){
  let collection = await getCollection(collection_id);
  let dir = collection.collection_path
  return lsCnt(dir)
}

function lsCnt(dir){
  let ls = fs.readdirSync(dir, { withFileTypes: true });
  let files = ls.filter(x=>!x.isDirectory()).length;
  
  return files + ls.filter(x=>x.isDirectory())
    .map(d=>lsCnt(path.join(dir, d.name)))
    .reduce((acc,curr)=>acc+curr, 0)
}
