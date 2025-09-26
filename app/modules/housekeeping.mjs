import { config } from '../config.mjs';
import 'dotenv/config';

import { getAllCollections } from '../database/collection-db.mjs';
import {indexCollection} from './indexer.mjs';
import {exiftool} from 'exiftool-vendored';
import {startWatchersForAllCollections, stopAllWatchers} from './watcher.mjs';
import {db} from '../database/sqlite-database.mjs';
import {closePool} from '../database/db-pool.mjs';
import {saveRateLimitState} from './reverse-geo-encoding.mjs';
import {startNightlyIndexing, stopNightlyIndexing} from './nightly-indexing.mjs';

export async function startUpActivities(){
  // Check if geonames username is configured
  if (!process.env.GEONAMES_USERNAME) {
    throw new Error('GEONAMES_USERNAME environment variable is required but not set');
  }

  // setup watch during start-up
  if(config.startFileWatcherAtStartup){
    await startWatchersForAllCollections();
  }

  // Scan for file additions / changes and index them
  if(config.scanFilesForChangesAndIndexAtStartup){
    let collections = await getAllCollections();
    for (let c of collections){
      indexCollection(c.collection_id, false)
        .then(()=>console.log('done indexing'))
      ;
    }
  }

  // Start nightly indexing
  startNightlyIndexing();
}

export async function shutdownCleanup(){
  stopAllWatchers();
  stopNightlyIndexing();
  saveRateLimitState();  // save rate limiting counters
  exiftool.end();
  closePool();
  db.close();
}
