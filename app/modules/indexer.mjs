import * as fs from 'fs';
const fsPromises = fs.promises;
import {EOL} from 'os';
import {EventEmitter} from 'events';
import * as path from 'path';

import {v4 as uuidv4} from 'uuid';
import dateFormat from 'dateformat';

import * as collections from './collections.mjs';
import * as m from './helpers/metadata.mjs';
import * as thumbs from './helpers/thumbnails.mjs';
import * as fileOps from './helpers/file-ops.mjs';

import { ParallelProcesses as pp } from '../utils/parallel-processes.mjs';
import {config} from '../config.mjs';
import * as db from '../database/indexer-db.mjs';

// to be used in case of emergencies like shutdown, etc.
export let indexerDbFlush = ()=>db.indexerDbWriteInChunks.runNow();

class EmitterClass extends EventEmitter {};
export const indexerEvents = new EmitterClass();

let indexerQueue = pp()
  .maxConcurrency(config.maxIndexerConcurrency)
  .emitter(indexerEvents)
;

export function pauseIndexer(){
  indexerQueue.pause();
}

export function resumeIndexer(){
  indexerQueue.resume();
}

export function updateIndexerConcurrency(concurrency){
  let c = Number(concurrency)
  // update indexerQueue
  indexerQueue.maxConcurrency(c);

  // update config
  config.maxIndexerConcurrency=c;

  // TODO permananet storage?
}

export const indexerStatus = ()=>indexerQueue.status();

export const indexerErrors = [];

// indexerEvents.on('start', (_)=>{console.log(`starting ${_}`)});
// indexerEvents.on('end', (_)=>{console.log(`finished ${_}`)});
// indexerEvents.on('all_done', (_)=>{console.log(`completed batch`)});

let indexerBatchStart;

indexerEvents.on('start_batch', ()=>{
  indexerBatchStart = performance.now();
});

indexerEvents.on('all_done', ()=>{
  console.log(`Finished Indexer batch in ${(performance.now()-indexerBatchStart)/1000/60} mins`)
});

indexerEvents.on('error', (item, error)=>{
  console.log(`IndexerEvents got error: ${item} ${error}`);
  indexerErrors.push(error);
})

export function addToIndexQueue(collection, filename, uuid, inPlace){
  indexerQueue.enqueue(indexFile, [collection, filename, uuid, inPlace])
}


// TODO: see if this can be used in the main indexFile function as well?
export async function refreshThumbs(uuid){
  let meta = db.retriveMetadata(uuid),
    imageFileName = meta.filename, playImageOverlay = false;
  
  if (meta.mediatype == 'video'){
    imageFileName = await thumbs.generateVideoThumbnail(uuid, meta.filename);
    playImageOverlay=true;
  }

  let buf = fs.readFileSync(imageFileName);
  await thumbs.createImageThumbnails(uuid, buf, playImageOverlay);
  // not extracting face regions here
  // TODO: Should I?
}

async function indexFile(collection, sourceFileName, uuid, inPlace){
  // indexing is a series of steps, where the latter steps
  // are dependent on former steps
  console.log(`Indexing ${sourceFileName}`);
  let fileStart = performance.now();
  
  // Step 1: Read metadata from file
  // unfortunately cannot pass buffer here
  try{
    var p = await m.getMetadata(sourceFileName);
  } catch(error){
    throw `ERROR during getMetadata for file: ${sourceFileName}: ${error}`;
  }

  // TODO: split this into i) get album name and ii) move the file to collection at the end
  // Step 2: Use the metadata to physically move the file into collection. Determine album
  try{
    var f = await fileOps.placeFileInCollection(collection, sourceFileName, p.file_date, inPlace);
  } catch(error){
    throw `ERROR during placeFileInCollection for file: ${sourceFileName}: ${error}`;
  }
  
  // Step 3: Generate uuid, and make metadata current
  try{
    p = {...p, ...f, uuid: uuid ? uuid : uuidv4(), collection_id: collection.collection_id}
  } catch(error){
    throw `ERROR during Generate uuid for file: ${sourceFileName}: ${error}`;
  }
  
  // Step 4: Video thumbnail extraction
  if(p.mediatype == "video" || p.mediatype == "image"){

    let imageFileName = p.filename, playImageOverlay=false;
    if(p.mediatype == "video"){
      try{
        // extract video thumbnail (screenshot) and use that image to extract image thumbs
        imageFileName = await thumbs.generateVideoThumbnail(p.uuid, p.filename);
        playImageOverlay=true;
      } catch(error){
        throw `ERROR during generateVideoThumbnail for file: ${sourceFileName}: ${error}`;
      }
    }

    // read image once
    let buf;
    try{
      buf = fs.readFileSync(imageFileName);
    } catch(error){
      throw `ERROR during readFileSync before thumbnail ${sourceFileName} ${error}`
    }

    // thumbnails generation
    try{
      await thumbs.createImageThumbnails(p.uuid, buf, playImageOverlay);
    } catch(error){
      throw `ERROR during createImageThumbnails for file: ${sourceFileName}: ${error}`;
    }

    // face region extraction (if present)
    if (p.xmpregion
      && p.xmpregion.RegionList.filter(d => d.Type == 'Face').length > 0
      && p.xmpregion.AppliedToDimensions.Unit == 'pixel') // TODO: don't know what to do with others just yet
    {
      let { W, H } = p.xmpregion.AppliedToDimensions;
      if (W != p.ImageWidth || H != p.ImageHeight) {
        // TODO: what should we do when RegionAppliedToDimensions don't match image height and width?
        console.warn(`${imageFileName} has different region dimensions! Actual ${p.ImageWidth}x${p.ImageWidth} vs ${W}x${H}`);
      }
      try{
        p.parsedFaces = await thumbs.extractFaceRegions(p.uuid, buf, p.xmpregion);
      } catch(error){
        throw `ERROR during extractFaceRegions for file: ${sourceFileName}: ${error}`;
      }
    }
  }
  
  // Step 6: Make an entry in db
  db.indexerDbWriteInChunks.add( {action: 'insert', data: p} );

  console.log(`${sourceFileName} finished in ${performance.now()-fileStart} ms`);
}

async function deleteFromCollection(uuid){
  let start = performance.now();
  console.log(`DELETE: start to delete for uuid: ${uuid}`);

  let filename = db.getFileName(uuid);
  // TODO: read trash folder for collection, and if present, move file to trash
  // but we don't want to query the collection for every delete, so need to think of a better solution

  // cleanup thumbnails
  thumbs.deleteImageThumbnails(uuid);
  // delete faces
  thumbs.deleteFaceThumbnails(uuid);
  // remove from db
  db.indexerDbWriteInChunks.add( {action: 'delete', data: {uuid: uuid}} );

  // the file is already gone, so no need to try to remove it
  //fileOps.deleteFile(filename);
  
  console.log(`Completed DELETE for ${uuid} in ${performance.now()-start} ms`);
}

export async function indexCollection(collection_id, firstTime=false){

  return new Promise(async (resolve, reject)=>{
    // TODO: should this accept a collection instead of collection_id?
    let c = collections.getCollection(collection_id);
    let files = [];
  
    if(firstTime){
      // save some time, and just get a list of all files
      files = {added: fileOps.listAllFilesForCollection(c), changed:[], deleted: []};
    } else {
      // painstakingly find out which files are added/updated/removed
      files = await listDeltaFilesForCollection(c);
    }

    console.log(`added: ${files.added.length} changed ${files.changed.length} deleted ${files.deleted.length}`);

//    if(files['deleted'].length > 0){
//      if(files['deleted'].length > config.filesDeletedThreshold){
//	    let deletedFileNames = files['deleted'].map(x=>`${x.uuid} ${x.filename}`).join("\n");
//        throw(`Found ${files['deleted'].length} files deleted. Something wrong?
//	      ${deletedFileNames}
//	    `)
//      } else {
//        indexerQueue.enqueueMany(
//          files['deleted'].map(f=>{
//            return ()=>deleteFromCollection(f.uuid);
//          })
//        );
//      }
//
//    }
  
    // add files to the indexer queue

    if(files['added'].length > 0){
      indexerQueue.enqueueMany(
        files['added'].map(f=>{
          return [indexFile, [c, f, null, true]];
        })
      );
    }
    
    if(files['changed'].length > 0){
      indexerQueue.enqueueMany(
        files['changed'].map(f=>{
          return [indexFile, [c, f.filename, f.uuid, true]];
        })
      );
    }

    resolve()
    
  })
}

export async function updateAlbum(collection_id, fromAlbum, toAlbum){
  let c = collections.getCollection(collection_id);
  let currFolderName=path.join(c.collection_path,fromAlbum),
  newFolderName=path.join(c.collection_path,toAlbum)
  
  if(c.album_type=="FOLDER_ALBUM"){
    fileOps.renameFolder(currFolderName, newFolderName);  
  }
  
  return db.updateAlbum(
    collection_id, fromAlbum, toAlbum, 
    c.album_type=="FOLDER_ALBUM" ? true : false  // whether to update file name
  );
}

export async function moveItemsToAlbum(collection_id, uuid_arr, newAlbumName){
  let c = collections.getCollection(collection_id),
    newPath = path.join(c.collection_path, newAlbumName);
  
  // TODO: convert this to array of promises?
  for(let uuid of uuid_arr){
    let f = db.getFileName(uuid);
    await fileOps.moveItem(f, path.join(newPath, path.basename(f)));
  }
  return db.updateAlbumForItems(
    uuid_arr, newAlbumName,
    c.album_type=="FOLDER_ALBUM" ? true : false  // whether to update file name
  );
}

export async function moveFileToTrash(uuid_arr){
  // Rename file to start with '.Trash_' and update trashed flag in db
  for(let uuid of uuid_arr){
    let f = db.getFileName(uuid),
      filename = path.basename(f),
      trashFilename = path.join(path.dirname(f), `.Trash_${filename}`);
    
    await fileOps.moveItem(f, trashFilename);
    db.trashItem(uuid, trashFilename);
  }

}

export let ignoreWatcherList = {};

async function listDeltaFilesForCollection(collection) {
  let start = performance.now();
  // Step 1: list all files and their modify times for collection
  let p1 = fileOps.getFilesMtime(collection.collection_path);

  // Step 2: Get files and modify times from db
  let p2 = db.getIndexedFilesModifyTime(collection.collection_id);

  // Step 3: Wait for promises to complete
  let [physicalFiles, databaseEntriesArr] = await Promise.all([p1, p2]);
  
  // convert db output into hash map
  let databaseEntries = databaseEntriesArr.reduce(function(acc,curr){
      acc[curr.filename]={
        uuid: curr.uuid, 
        mtime: Math.floor( (new Date(curr.file_modify_date).getTime()) / 1000)  // Unix Epoch
      }; 
      return acc;
    }, {})

  console.log(`physicalFiles ${Object.keys(physicalFiles).length} databaseEntries: ${Object.keys(databaseEntries).length}`);
  console.log(`Time taken to figure out files ${(performance.now()-start)/1000/60} mins`)

  // Step 4: compare the two and determine which have been added/removed/modified
  let added = [], changed = [], deleted = [];

  Object.keys(physicalFiles).forEach(f => {
    if (!(f in databaseEntries)) {
      added.push(f);
    } else if (physicalFiles[f].mtime > databaseEntries[f].mtime) {
      console.log(`${f} is changed`)
      changed.push({ uuid: databaseEntries[f].uuid, filename: f });
    }
  });

  Object.keys(databaseEntries).forEach(f => {
    if (!(f in physicalFiles)) {
      console.log(`${f} is deleted`)
      deleted.push({ uuid: databaseEntries[f].uuid, filename: f });
    }
  });

  return { added, changed, deleted };
}

export async function refreshMetadataForCollection(collection_id){
  let allFiles = await db.getIndexedFilesModifyTime(collection_id);
  
  console.log(`Re-extracting metadata for ${allFiles.length} files`);
  
  indexerQueue.enqueueMany(
    allFiles.map(file=>{
      return [refreshMetadata, [file.uuid, file.filename]];
    })
  );
  
}

export async function refreshMetadata(uuid, filename){
  if(!filename){
    filename = db.getFileName(uuid);
  }
  console.log(`Re-extracting metadata for ${filename}`);

  // get metadata from exiftool
  let metadata = await m.getMetadata(filename);
  metadata['uuid'] = uuid;

  db.indexerDbWriteInChunks.add( {action: 'update', data: metadata} );

}

// TODO: need to think of a generic function for other metadata as well
export function updateRating(uuid_arr, newRating){
  // let fileName = db.getFileName(uuid);

  // // make an entry to the ignore watcher list so that chokidar can ignore
  // // the 'change' it sees on this file.
  // ignoreWatcherList[fileName] = true;

  // we also update the file modify date so that next time server starts up, it doesn't
  // see this as a new file and re-indexes it
  let fileModifyDate = dateFormat(new Date(), 'isoDateTime');

  // try{
  //   await m.updateMetadata(fileName, {Rating: newRating, FileModifyDate: fileModifyDate});
  // } catch(err){
  //   // updates to metadata wasn't successful
  //   // remove file from ignore list and throw error
  //   delete(ignoreWatcherList[fileName]);
  //   throw err.message;
  // }

  db.updateRating(uuid_arr, newRating, fileModifyDate);
  db.scheduleExif(uuid_arr, {Rating: newRating, FileModifyDate: fileModifyDate});

}
