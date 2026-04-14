import { addJob, deleteJob } from '#infra/scheduler';
import { config } from '#runtime-config';
import { startIntakeFileIndexing } from '#indexing/intake-indexer';
import { getAllCollections } from '#collections/collection-manager';
import { indexerStatus } from '#indexing/queue-manager';
import { createLogger } from '#utils/logger';

const logger = createLogger(import.meta.url);

let cronJobs = new Set();

export async function scheduleCronJobs() {
  if (!config.enableScheduledIndexing) {
    logger.info('Scheduled indexing is disabled');
    return;
  }
  
  const collections = await getAllCollections();
  let jobIndex = 0;
  
  for (const collection of collections) {
    for (const intakeConfig of collection.intake_configs) {
      if (intakeConfig.method === 'scheduled') {
        const schedule = intakeConfig.config?.schedule || '0 1 * * *';
        const staleDays = intakeConfig.config?.staleDays;
        const jobName = `scheduled-indexing-${jobIndex++}`;
        
        cronJobs.add(jobName);
        addJob(
          jobName, 
          schedule,
          () => checkAndStartScheduledIndexing(collection.collection_id, intakeConfig.path, staleDays)
        );
        logger.info(`Created scheduled job ${jobName} with schedule ${schedule} for path: ${intakeConfig.path}`);
      }
    }
  }
}

async function checkAndStartScheduledIndexing(collection_id, intakePath, staleDays) {
  // For manually triggered indexing, we assume the user knows what they are doing,
  // and won't schedule the same files multiple times.
  // However, for scheduled indexing, in case the indexer is running, we do not know
  // if that is a previously triggered scheduled job that is long running, or a manual job.

  // Hence, in order to prevent the same files being lined up for indexing, we skip
  // this run if the indexer is already found running.
  if (indexerStatus.processingCnt > 0 || indexerStatus.pendingCnt > 0) {
    logger.warn('Indexer is currently running. Skipping new file indexing.');
    return;
  }
  await startIntakeFileIndexing(collection_id, intakePath, staleDays);
}

export function stopScheduledIndexing() {
  for (const jobName of cronJobs) {
    deleteJob(jobName);
  }
  cronJobs.clear();
}