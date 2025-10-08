import * as path from 'path';
import chokidar from 'chokidar';
import { createLogger } from '#utils/logger';

import {config} from '#config';
import {getAllCollections} from '#collections/collection-manager';
import {addToIndexQueue, ignoreWatcherList} from '#indexing/queue-manager';
import {indexFile} from '#indexing/file-indexer';
import {shouldIgnoreFile} from '#utils/file-filters';

const logger = createLogger(import.meta.url);

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
          logger.debug(`ignoring file ${file}`);
          return;
        }

        logger.info(`watcher: ${file} is added`);
        addToIndexQueue(indexFile, [collection, file, null, false]);
      })
    ;
    
    allWatchers.push({
      collection_id: collection.collection_id, 
      listen_path: p, 
      watcher: w
    });
    logger.info(`watcher for collection_id: ${collection.collection_id} listen_path: ${p} is now setup`);
  }
}

export function listAllWatchers(){
  return allWatchers;
}

export function stopAllWatchers(){
  allWatchers.map(async function(x){
    logger.info(`closing watcher for collection_id: ${x.collection_id} listen_path: ${x.listen_path}`);
    await x['watcher'].close();
    logger.info(`watcher for ${x.listen_path} closed`);
  })
}