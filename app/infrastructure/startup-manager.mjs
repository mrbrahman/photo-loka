import { config } from '../config.mjs';
import 'dotenv/config';

import { getAllCollections } from '../core/collections/collection-manager.mjs';
import { indexCollection } from '../core/indexing/batch-indexer.mjs';
import { startWatchersForAllCollections } from './file-watcher.mjs';
import { startNightlyIndexing } from '../jobs/nightly-indexing-job.mjs';

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