import * as fs from 'fs';
import * as path from 'path';
import dateformat from 'dateformat';

import * as watcher from '#jobs/file-watcher-job';
import * as cronJobs from '#jobs/scheduled-indexing-job';
import * as db from './collection-db.mjs';
import { AppError } from '#utils/app-error';

export async function createNewCollection(record){
  if(!isValidDir(record.collection_path)){
    throw new AppError(`${record.collection_path} is not a valid path in collection path`, 'ValidationError', 'INVALID_PATH', 400);
  }

  for (let intakeConfig of record.intake_configs){
    if(!isValidDir(intakeConfig.path)){
      throw new AppError(`${intakeConfig.path} is not a valid path in intake config`, 'ValidationError', 'INVALID_PATH', 400);
    }
    if(!['immediate', 'scheduled', 'on-demand'].includes(intakeConfig.method)){
      throw new AppError(`${intakeConfig.method} is not a valid method. Use 'immediate' or 'scheduled'`, 'ValidationError', 'INVALID_METHOD', 400);
    }
  }

  let albumTypes = ['FOLDER_ALBUM','VIRTUAL_ALBUM']
  if(albumTypes.indexOf(record.album_type)<0){
    throw new AppError(`${record.album_type} is invalid album type. Valid values are: ${albumTypes.join(', ')}`, 'ValidationError', 'INVALID_ALBUM_TYPE', 400);
  }
  
  let id = await db.createNewCollection(record);
  watcher.startWatcherForCollection({collection_id: id, ...record});
  cronJobs.scheduleCronJobsForCollection({collection_id: id, ...record});
  
  return id;
} 

export async function updateCollection(collection_id, record){
  if(!isValidDir(record.collection_path)){
    throw new AppError(`${record.collection_path} is not a valid path in collection path`, 'ValidationError', 'INVALID_PATH', 400);
  }

  for (let intakeConfig of record.intake_configs){
    if(!isValidDir(intakeConfig.path)){
      throw new AppError(`${intakeConfig.path} is not a valid path in intake config`, 'ValidationError', 'INVALID_PATH', 400);
    }
    if(!['immediate', 'scheduled', 'on-demand'].includes(intakeConfig.method)){
      throw new AppError(`${intakeConfig.method} is not a valid method. Use 'immediate', 'scheduled', or 'on-demand'`, 'ValidationError', 'INVALID_METHOD', 400);
    }
  }

  let albumTypes = ['FOLDER_ALBUM','VIRTUAL_ALBUM']
  if(albumTypes.indexOf(record.album_type)<0){
    throw new AppError(`${record.album_type} is invalid album type. Valid values are: ${albumTypes.join(', ')}`, 'ValidationError', 'INVALID_ALBUM_TYPE', 400);
  }

  await db.updateCollection(collection_id, record);

  // Restart watchers and cron jobs with updated config
  watcher.stopWatcherForCollection(collection_id);
  cronJobs.stopCronJobsForCollection(collection_id);
  watcher.startWatcherForCollection({collection_id, ...record});
  cronJobs.scheduleCronJobsForCollection({collection_id, ...record});
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

export async function getCollectionByIntakePath(dirPath){
  return await db.getCollectionByIntakePath(dirPath)
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

export function validateFolderPattern(pattern){
  try {
    let example = dateformat(new Date(), pattern);
    return { valid: true, example };
  } catch(e) {
    return { valid: false, error: e.message };
  }
}

export async function setIntakeStatus(collection_id, intakeIndex, status) {
  let collection = await db.getCollection(collection_id);
  if (!collection) {
    throw new AppError('Collection not found', 'ValidationError', 'NOT_FOUND', 404);
  }
  if (intakeIndex < 0 || intakeIndex >= collection.intake_configs.length) {
    throw new AppError('Invalid intake index', 'ValidationError', 'INVALID_INDEX', 400);
  }
  if (!['active', 'stopped'].includes(status)) {
    throw new AppError('Status must be "active" or "stopped"', 'ValidationError', 'INVALID_STATUS', 400);
  }

  await db.setIntakeStatusByIndex(collection_id, intakeIndex, status);

  // Restart watchers and cron for this collection
  let updated = await db.getCollection(collection_id);
  watcher.stopWatcherForCollection(collection_id);
  cronJobs.stopCronJobsForCollection(collection_id);
  watcher.startWatcherForCollection(updated);
  cronJobs.scheduleCronJobsForCollection(updated);

  return updated.intake_configs;
}

export async function setAllIntakeStatus(collection_id, status) {
  let collection = await db.getCollection(collection_id);
  if (!collection) {
    throw new AppError('Collection not found', 'ValidationError', 'NOT_FOUND', 404);
  }
  if (!['active', 'stopped'].includes(status)) {
    throw new AppError('Status must be "active" or "stopped"', 'ValidationError', 'INVALID_STATUS', 400);
  }

  await db.setAllIntakeStatusForCollection(collection_id, status);

  // Restart watchers and cron for this collection
  let updated = await db.getCollection(collection_id);
  watcher.stopWatcherForCollection(collection_id);
  cronJobs.stopCronJobsForCollection(collection_id);
  if (status === 'active') {
    watcher.startWatcherForCollection(updated);
    cronJobs.scheduleCronJobsForCollection(updated);
  }

  return updated.intake_configs;
}

export async function setIntakeStatusByMethod(method, status) {
  await db.setIntakeStatusByMethod(method, status);
}
