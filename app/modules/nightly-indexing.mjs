import cron from 'node-cron';
import { fdir } from 'fdir';
import { stat } from 'fs/promises';
import { config } from '../config.mjs';
import { getAllCollections } from './collections.mjs';
import { bulkAddToIndexQueue } from './indexer.mjs';

let cronJob = null;

export function startNightlyIndexing() {
  if (!config.enableNightlyIndexing) {
    console.log('Nightly indexing is disabled');
    return;
  }

  // Run every night at 2 AM
  cronJob = cron.schedule('0 2 * * *', async () => {
    console.log('Starting nightly indexing...');
    try {
      await processFiles();
      console.log('Nightly indexing completed');
    } catch (error) {
      console.error('Error during nightly indexing:', error);
    }
  }, {
    scheduled: false
  });

  cronJob.start();
  console.log('Nightly indexing started (runs at 2 AM daily)');
}

export function stopNightlyIndexing() {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
    console.log('Nightly indexing stopped');
  }
}

async function processFiles() {
  const collections = await getAllCollections();
  // Files older than this date will be indexed (mtime < cutoffDate)
  // When delay is 0, cutoffDate = now (index all files)
  const cutoffDate = new Date(Date.now() - (config.nightlyIndexingDelayDays * 24 * 60 * 60 * 1000));
  
  for (const collection of collections) {
    for (const listenPath of collection.listen_paths) {
      console.log(`Checking for files in: ${listenPath}`);
      
      try {
        const pendingFiles = await findPendingFiles(listenPath, cutoffDate);
        
        if (pendingFiles.length > 0) {
          console.log(`Found ${pendingFiles.length} files in ${listenPath}`);
          bulkAddToIndexQueue(collection, pendingFiles);
        }
      } catch (error) {
        console.error(`Error checking files in ${listenPath}:`, error);
      }
    }
  }
}

async function findPendingFiles(dirPath, cutoffDate) {
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
