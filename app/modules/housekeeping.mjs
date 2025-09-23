import { config } from '../config.mjs';
import 'dotenv/config';

import { getAllCollections } from '../database/collection-db.mjs';
import {indexCollection} from './indexer.mjs';
import {exiftool} from 'exiftool-vendored';
import {startWatchersForAllCollections, stopAllWatchers} from './watcher.mjs';
import {db} from '../database/sqlite-database.mjs';
import {saveRateLimitState} from './reverse-geo-encoding.mjs';

export function startUpActivities(){
  // Check if geonames username is configured
  if (!process.env.GEONAMES_USERNAME) {
    throw new Error('GEONAMES_USERNAME environment variable is required but not set');
  }

  // setup watch during start-up
  if(config.startFileWatcherAtStartup){
    startWatchersForAllCollections();
  }

  // Scan for file additions / changes and index them
  if(config.scanFilesForChangesAndIndexAtStartup){
    let collections = getAllCollections();
    for (let c of collections){
      indexCollection(c.collection_id, false)
        .then(()=>console.log('done indexing'))
      ;
    }
  }
}

export async function shutdownCleanup(){
  stopAllWatchers();
  saveRateLimitState();  // save rate limiting counters
  exiftool.end();
  db.close();
}
