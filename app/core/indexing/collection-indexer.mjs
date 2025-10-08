import * as fileOps from './file-organizer.mjs';
import * as db from './indexer-db.mjs';
import { bulkAddToIndexQueue } from './queue-manager.mjs';
import { getCollection } from '#collections/collection-manager';
import { indexFile } from './file-indexer.mjs';
import { refreshMetadata } from './metadata-updates.mjs';

export async function indexCollection(collection_id, firstTime=false){

  return new Promise(async (resolve, reject)=>{
    // TODO: should this accept a collection instead of collection_id?
    let c = await getCollection(collection_id);
    let files = [];
  
    if(firstTime){
      // save some time, and just get a list of all files
      files = {added: await fileOps.listAllFilesForCollection(c), changed:[], deleted: []};
    } else {
      // painstakingly find out which files are added/updated/removed
      files = await listDeltaFilesForCollection(c);
    }

    console.log(`added: ${files.added.length} changed ${files.changed.length} deleted ${files.deleted.length}`);
    // console.log(`added files: ${JSON.stringify(files.added)}`);
    // console.log(`changed files: ${JSON.stringify(files.changed)}`);

    // add files to the indexer queue
    if(files['added'].length > 0){
      bulkAddToIndexQueue(
        files['added'].map(f=>{
          return [indexFile, [c, f, null, true]];
        })
      );
    }
    
    if(files['changed'].length > 0){
      bulkAddToIndexQueue(
        files['changed'].map(f=>{
          return [indexFile, [c, f.filename, f.uuid, true]];
        })
      );
    }

    resolve()
  })
}

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
      console.log(`${f} is added`)
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
  
  bulkAddToIndexQueue(
    allFiles.map(file=>{
      return [refreshMetadata, [file.uuid, file.filename]];
    })
  );
}
