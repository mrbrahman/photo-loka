import { addJob, deleteJob } from '#infra/scheduler';
import { config } from '#runtime-config';
import { startIntakeFileIndexing } from '#indexing/intake-indexer';
import { getAllCollections } from '#collections/collection-manager';
import { indexerStatus } from '#indexing/queue-manager';
import { createLogger } from '#utils/logger';

const logger = createLogger(import.meta.url);

// Map of jobName -> collection_id for tracking
let cronJobs = new Map();

export async function scheduleCronJobs() {
  if (!config.startScheduledIndexingAtStartup) {
    logger.info('Scheduled indexing at startup is disabled');
    return;
  }

  const collections = await getAllCollections();
  for (const collection of collections) {
    scheduleCronJobsForCollection(collection);
  }
}

export function scheduleCronJobsForCollection(collection) {
  for (let i = 0; i < collection.intake_configs.length; i++) {
    const intakeConfig = collection.intake_configs[i];
    if (intakeConfig.method !== 'scheduled') continue;
    if (intakeConfig.status === 'stopped') continue;

    const schedule = intakeConfig.config?.schedule || '0 1 * * *';
    const staleDays = intakeConfig.config?.staleDays;
    const jobName = `cron-c${collection.collection_id}-i${i}`;

    if (cronJobs.has(jobName)) continue; // already scheduled

    addJob(
      jobName,
      schedule,
      () => checkAndStartScheduledIndexing(collection.collection_id, intakeConfig.path, staleDays)
    );
    cronJobs.set(jobName, collection.collection_id);
    logger.info(`Created scheduled job ${jobName} with schedule ${schedule} for path: ${intakeConfig.path}`);
  }
}

export function stopCronJobsForCollection(collection_id) {
  for (const [jobName, cid] of cronJobs.entries()) {
    if (cid === collection_id) {
      deleteJob(jobName);
      cronJobs.delete(jobName);
    }
  }
}

export function stopAllScheduledIndexing() {
  for (const [jobName] of cronJobs.entries()) {
    deleteJob(jobName);
  }
  cronJobs.clear();
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
