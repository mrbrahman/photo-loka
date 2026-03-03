import { config } from '#config';
import 'dotenv/config';
import { createLogger } from '#utils/logger';

import { getAllCollections } from '#collections/collection-manager';
import { indexCollection } from '#indexing/collection-indexer';
import { startWatchersForAllCollections } from '#jobs/file-watcher-job';
import { scheduleCronJobs } from '#jobs/scheduled-indexing-job';
import { scheduleFrameJobs } from '#jobs/frame-jobs';
import { loadAllFrames } from '#frame/frame-manager';
import * as systemMonitor from '#infra/system-monitor';

const logger = createLogger(import.meta.url);

export async function startUpActivities(){
  // Check if geonames username is configured
  if (!process.env.GEONAMES_USERNAME) {
    throw new Error('GEONAMES_USERNAME environment variable is required but not set');
  }

  // Start system load monitoring
  systemMonitor.start();

  // setup watch during start-up
  if(config.startFileWatcherAtStartup){
    await startWatchersForAllCollections();
  }

  // Scan for file additions / changes and index them
  if(config.scanFilesForChangesAndIndexAtStartup){
    let collections = await getAllCollections();
    for (let c of collections){
      indexCollection(c.collection_id, false)
        .then(()=>logger.info(`Completed indexing setup for collection ${c.collection_id}`))
      ;
    }
  }

  // Start scheduled indexing
  scheduleCronJobs();

  // Load all frames
  await loadAllFrames();

  // Schedule frame jobs
  scheduleFrameJobs();
}
