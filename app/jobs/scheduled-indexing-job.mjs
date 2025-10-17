import { addJob, deleteJob } from '#infra/scheduler';
import { config } from '#config';
import { enqueueNewFiles } from '#indexing/new-files-indexer';
import { getAllCollections } from '#collections/collection-manager';
import { createLogger } from '#utils/logger';

const logger = createLogger(import.meta.url);

let cronJobs = new Set();

export async function startScheduledIndexing() {
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
        addJob(jobName, schedule, () => enqueueNewFiles(collection, intakeConfig.path, staleDays));
        logger.info(`Created scheduled job ${jobName} with schedule ${schedule} for path: ${intakeConfig.path}`);
      }
    }
  }
}

export function stopScheduledIndexing() {
  for (const jobName of cronJobs) {
    deleteJob(jobName);
  }
  cronJobs.clear();
}