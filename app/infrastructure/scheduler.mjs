import cron from 'node-cron';
import { fdir } from 'fdir';
import { stat } from 'fs/promises';
import { config } from '../config.mjs';
import * as nightlyIndexingJob from '../jobs/nightly-indexing-job.mjs';

const registeredJobs = new Map();

export function registerJob(name, cronPattern, handler) {
  if (registeredJobs.has(name)) {
    console.warn(`Job ${name} is already registered`);
    return;
  }
  
  const job = cron.schedule(cronPattern, async () => {
    try {
      await handler();
    } catch (error) {
      console.error(`Error in job ${name}:`, error);
    }
  }, { scheduled: false });
  
  registeredJobs.set(name, job);
  console.log(`Job ${name} registered with pattern ${cronPattern}`);
}

export function unregisterJob(name) {
  const job = registeredJobs.get(name);
  if (job) {
    job.stop();
    registeredJobs.delete(name);
    console.log(`Job ${name} unregistered`);
  }
}

export function startAllJobs() {
  registeredJobs.forEach((job, name) => {
    job.start();
    console.log(`Started job: ${name}`);
  });
}

export function stopAllJobs() {
  registeredJobs.forEach((job, name) => {
    job.stop();
    console.log(`Stopped job: ${name}`);
  });
}

export function getJobStatus(name) {
  const job = registeredJobs.get(name);
  return job ? { name, running: job.running } : null;
}

// Legacy functions for backward compatibility
export function startNightlyIndexing() {
  if (!config.enableNightlyIndexing) {
    console.log('Nightly indexing is disabled');
    return;
  }
  
  registerJob('nightly-indexing', '55 13 * * *', nightlyIndexingJob.run);
  const job = registeredJobs.get('nightly-indexing');
  if (job) job.start();
}

export function stopNightlyIndexing() {
  unregisterJob('nightly-indexing');
}

// Utility function for jobs
export async function findPendingFiles(dirPath, cutoffDate) {
  const allFiles = await new fdir()
    .withFullPaths()
    .crawl(dirPath)
    .withPromise();

  const pendingFiles = [];
  for (const filePath of allFiles) {
    try {
      const stats = await stat(filePath);
      if (stats.mtime < cutoffDate) {
        pendingFiles.push(filePath);
      }
    } catch (error) {
      console.warn(`Could not stat file ${filePath}:`, error.message);
    }
  }
  
  return pendingFiles;
}