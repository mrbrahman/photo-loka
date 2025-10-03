import {fdir} from 'fdir';
import { stat } from 'fs/promises';
import path from 'path';

import { addJob, deleteJob } from '../infrastructure/scheduler.mjs';
import { getAllCollections } from '../core/collections/collection-manager.mjs';
import { bulkAddToIndexQueue } from '../core/indexing/queue-manager.mjs';
import { indexFile } from '../core/indexing/file-indexer.mjs';
import { config } from '../config.mjs';

export function startNightlyIndexing() {
  if (!config.enableNightlyIndexing) {
    console.log('Nightly indexing is disabled');
    return;
  }
  
  addJob('nightly-indexing', '0 1 * * *', run);
}

export function stopNightlyIndexing() {
  deleteJob('nightly-indexing');
}

// Utility function for jobs
async function findPendingFiles(dirPath, cutoffDate) {
  const allFiles = await new fdir()
    .withFullPaths()
    .filter((filePath) => !path.basename(filePath).startsWith('.'))  // exclude . files
    .crawl(dirPath)
    .withPromise();

  const pendingFiles = [];
  for (const filePath of allFiles) {
    try {
      const stats = await stat(filePath);
      console.log(stats.mtime);
      console.log(cutoffDate);
      if (stats.mtime < cutoffDate) {
        pendingFiles.push(filePath);
      }
    } catch (error) {
      console.warn(`Could not stat file ${filePath}:`, error.message);
    }
  }
  
  return pendingFiles;
}

async function run() {
  console.log('Starting nightly indexing job...');
  
  const collections = await getAllCollections();
  // Files older than this date will be indexed (mtime < cutoffDate)
  const cutoffDate = new Date(Date.now() - (config.nightlyIndexingDelayDays * 24 * 60 * 60 * 1000));
  
  for (const collection of collections) {
    for (const listenPath of collection.listen_paths) {
      console.log(`Checking for files in: ${listenPath}`);
      
      try {
        const pendingFiles = await findPendingFiles(listenPath, cutoffDate);
        
        if (pendingFiles.length > 0) {
          console.log(`Found ${pendingFiles.length} files in ${listenPath}`);
          bulkAddToIndexQueue(
            pendingFiles.map(f=>{
              return [indexFile, [collection, f, null, false]];
            })
          );
        }
      } catch (error) {
        console.error(`Error checking files in ${listenPath}:`, error);
      }
    }
  }
  
  console.log('Nightly indexing job completed');
}
