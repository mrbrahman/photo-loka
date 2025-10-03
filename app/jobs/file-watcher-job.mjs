import * as path from 'path';
import chokidar from 'chokidar';

import {config} from '../config.mjs';
import {getAllCollections} from '../core/collections/collection-manager.mjs';
import {addToIndexQueue, ignoreWatcherList} from '../core/indexing/queue-manager.mjs';
import {indexFile} from '../core/indexing/file-indexer.mjs';
import {shouldIgnoreFile} from '../utils/file-filters.mjs';

// store an array of {collection_id: <id>, listen_path: <path>, watcher: <chokidar watcher>}
var allWatchers = [];

export async function startWatchersForAllCollections(){
  let collections = await getAllCollections();

  for(let c of collections){
    startWatcherForCollection(c);
  }
}

export function startWatcherForCollection(collection){
  for(let p of collection.listen_paths){
    let w = chokidar.watch(p, {
      ignored: shouldIgnoreFile
    })
      .on('add', file=>{
        if(ignoreWatcherList[file] != undefined){
          console.log(`ignoring file ${file}`);
          return;
        }

        console.log(`watcher: ${file} is added`);
        addToIndexQueue(indexFile, [collection, file, null, false]);
      })
    ;
    
    allWatchers.push({
      collection_id: collection.collection_id, 
      listen_path: p, 
      watcher: w
    });
    console.log(`watcher for collection_id: ${collection.collection_id} listen_path: ${p} is now setup`);
  }
}

export function listAllWatchers(){
  return allWatchers;
}

export function stopAllWatchers(){
  allWatchers.map(async function(x){
    console.log(`closing watcher for collection_id: ${x.collection_id} listen_path: ${x.listen_path}`);
    await x['watcher'].close();
    console.log(`watcher for ${x.listen_path} closed`);
  })
}