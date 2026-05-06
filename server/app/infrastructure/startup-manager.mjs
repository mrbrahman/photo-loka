import { config } from '#runtime-config';
import { startupConfig } from '#startup-config';
import { createLogger } from '#utils/logger';

import { getAllCollections } from '#collections/collection-manager';
import { setIntakeStatusByMethod } from '#collections/collection-manager';
import { scanForChanges } from '#indexing/collection-indexer';
import { startWatchersForAllCollections } from '#jobs/file-watcher-job';
import { scheduleCronJobs } from '#jobs/scheduled-indexing-job';
import { scheduleFrameJobs } from '#jobs/frame-jobs';
import { loadAllFrames } from '#frame/frame-manager';
import * as systemMonitor from '#infra/system-monitor';
import { scheduleTokenCleanup } from '#jobs/token-cleanup-job';
import { updateIndexerConcurrency } from '#indexing/queue-manager';

const logger = createLogger(import.meta.url);

export async function startUpActivities(){
  // Check if geonames username is configured
  if (!startupConfig.geonamesUsername) {
    throw new Error('GEONAMES_USERNAME environment variable is required but not set');
  }

  // Start system load monitoring (only needed for dynamic indexer mode)
  if(startupConfig.indexerMode === 'dynamic') systemMonitor.start();

  // Apply maxConcurrency from runtime config to the indexer queue
  // (queue is created at module load time with a CPU-based default)
  if(config.maxConcurrency) updateIndexerConcurrency(config.maxConcurrency);

  // setup watch during start-up
  if(config.startFileWatcherAtStartup){
    await startWatchersForAllCollections();
  } else {
    await setIntakeStatusByMethod('immediate', 'stopped');
    logger.info('File watcher at startup disabled - marked immediate intakes as stopped');
  }

  // Scan for file additions / changes and index them
  if(config.scanFilesForChangesAndIndexAtStartup){
    let collections = await getAllCollections();
    for (let c of collections){
      scanForChanges(c.collection_id)
        .then(()=>logger.info(`Completed scan for changes for collection ${c.collection_id}`))
      ;
    }
  }

  // Start scheduled indexing
  if(config.startScheduledIndexingAtStartup){
    scheduleCronJobs();
  } else {
    await setIntakeStatusByMethod('scheduled', 'stopped');
    logger.info('Scheduled indexing at startup disabled - marked scheduled intakes as stopped');
  }

  // Load all frames
  await loadAllFrames();

  // Schedule frame jobs
  scheduleFrameJobs();

  // Schedule token cleanup
  scheduleTokenCleanup();
}
