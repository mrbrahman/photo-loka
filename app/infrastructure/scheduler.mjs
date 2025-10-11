import cron from 'node-cron';
import { createLogger } from '#utils/logger';

const logger = createLogger(import.meta.url);

const activeJobs = new Map();

export function addJob(name, cronPattern, handler) {
  if (activeJobs.has(name)) {
    logger.warn(`Job ${name} is already active`);
    return;
  }
  
  const job = cron.schedule(cronPattern, async () => {
    try {
      await handler();
    } catch (error) {
      logger.error(`Error in job ${name}:`, error);
    }
  });
  
  activeJobs.set(name, job);
  logger.info(`Job ${name} registered with pattern ${cronPattern}`);
}

export function deleteJob(name) {
  const job = activeJobs.get(name);
  if (job) {
    job.stop();
    job.destroy();
    activeJobs.delete(name);
    logger.info(`Job ${name} unregistered`);
  }
}

export function deleteAllJobs() {
  activeJobs.forEach((job, name) => {
    job.stop();
    job.destroy();
    logger.info(`Removed job: ${name}`);
  });
}

export function getJobStatus(name) {
  const job = activeJobs.get(name);
  return job ? { name, running: job.running } : null;
}
