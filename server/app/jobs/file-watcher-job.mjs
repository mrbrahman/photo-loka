import * as path from 'path';
import chokidar from 'chokidar';
import { createLogger } from '#utils/logger';

import {getAllCollections} from '#collections/collection-manager';
import {addToIndexQueue, ignoreWatcherList} from '#indexing/queue-manager';
import {indexFile} from '#indexing/file-indexer';
import {shouldIgnoreFile} from '#utils/file-filters';

const logger = createLogger(import.meta.url);

/*
 * Chokidar watcher config options for frontend (method: "immediate"):
 * 
 * Performance & Stability:
 * - awaitWriteFinish: true | {stabilityThreshold: 2000, pollInterval: 100} - Wait for file writes to complete
 * - ignoreInitial: true - Don't trigger events for existing files on startup
 * - usePolling: true - Use polling instead of native events (for network drives)
 * - interval: 1000 - Polling interval in ms (default: 100)
 * 
 * File Filtering:
 * - depth: 3 - Limit directory traversal depth
 * - ignored: /pattern/ - Additional ignore patterns
 * 
 * Example configs:
 * {
 *   "awaitWriteFinish": true,
 *   "ignoreInitial": true,
 *   "depth": 3
 * }
 * 
 * {
 *   "usePolling": true,
 *   "interval": 1000,
 *   "awaitWriteFinish": {
 *     "stabilityThreshold": 2000,
 *     "pollInterval": 100
 *   }
 * }
 */

// store an array of {collection_id: <id>, intake_path: <path>, watcher: <chokidar watcher>}
let allWatchers = [];

export async function startWatchersForAllCollections(){
  let collections = await getAllCollections();

  for(let c of collections){
    startWatcherForCollection(c);
  }
}

export function startWatcherForCollection(collection){
  for(let intakeConfig of collection.intake_configs){
    if(intakeConfig.method !== 'immediate') continue;
    if(intakeConfig.status === 'stopped') continue;
    
    let w = chokidar.watch(intakeConfig.path, {
      ignored: shouldIgnoreFile,
      ...intakeConfig.config
    })
      .on('add', file=>{
        if(ignoreWatcherList[file] != undefined){
          logger.debug(`ignoring file ${file}`);
          return;
        }

        logger.info(`watcher: ${file} is added`);
        addToIndexQueue(indexFile, [collection, file, null, false], 'high');
      })
    ;
    
    allWatchers.push({
      collection_id: collection.collection_id, 
      intake_path: intakeConfig.path, 
      watcher: w
    });
    logger.info(`watcher for collection_id: ${collection.collection_id} intake_path: ${intakeConfig.path} is now setup`);
  }
}

export function stopWatcherForCollection(collection_id){
  let toStop = allWatchers.filter(x => x.collection_id === collection_id);
  for (let x of toStop) {
    logger.info(`closing watcher for collection_id: ${x.collection_id} intake_path: ${x.intake_path}`);
    x.watcher.close();
  }
  allWatchers = allWatchers.filter(x => x.collection_id !== collection_id);
}

export function listAllWatchers(){
  return allWatchers;
}

export function stopAllWatchers(){
  allWatchers.map(async function(x){
    logger.info(`closing watcher for collection_id: ${x.collection_id} intake_path: ${x.intake_path}`);
    await x['watcher'].close();
    logger.info(`watcher for ${x.intake_path} closed`);
  })
}