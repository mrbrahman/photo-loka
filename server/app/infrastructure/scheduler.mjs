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
  
  activeJobs.set(name, { task: job, pattern: cronPattern });
  logger.info(`Job ${name} registered with pattern ${cronPattern}`);
}

export function deleteJob(name) {
  const entry = activeJobs.get(name);
  if (entry) {
    entry.task.stop();
    entry.task.destroy();
    activeJobs.delete(name);
    logger.info(`Job ${name} unregistered`);
  }
}

export function deleteAllJobs() {
  activeJobs.forEach((entry, name) => {
    entry.task.stop();
    entry.task.destroy();
    logger.info(`Removed job: ${name}`);
  });
}

export function getJobStatus(name) {
  const entry = activeJobs.get(name);
  return entry ? { name, pattern: entry.pattern, running: true } : null;
}

export function listAllJobs() {
  const jobs = [];
  for (const [name, entry] of activeJobs) {
    jobs.push({ name, pattern: entry.pattern });
  }
  return jobs;
}
