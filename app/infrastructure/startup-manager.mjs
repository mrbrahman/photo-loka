import { config } from '#config';
import 'dotenv/config';

import { getAllCollections } from '#collections/collection-manager';
import { indexCollection } from '#indexing/collection-indexer';
import { startWatchersForAllCollections } from '#jobs/file-watcher-job';
import { startNightlyIndexing } from '#jobs/nightly-indexing-job';

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