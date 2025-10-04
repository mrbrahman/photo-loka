import {fdir} from 'fdir';
import { stat } from 'fs/promises';

import { getAllCollections } from '../collections/collection-manager.mjs';
import { bulkAddToIndexQueue, indexerStatus } from './queue-manager.mjs';
import { indexFile } from './file-indexer.mjs';
import { shouldIgnoreFile } from '../../utils/file-filters.mjs';
import { config } from '../../config.mjs';

async function enqueueStaleFiles() {
  console.log('Starting stale file indexing...');

  // Skip if indexer is already running
  if (indexerStatus.processingCnt > 0 || indexerStatus.pendingCnt > 0) {
    console.log('Indexer is currently running. Skipping stale file indexing.');
    return;
  }
  
  const collections = await getAllCollections();
  // Files older than this date will be indexed (mtime < cutoffDate)
  const cutoffDate = new Date(Date.now() - (config.staleDays * 24 * 60 * 60 * 1000));
  
  for (const collection of collections) {
    for (const listenPath of collection.listen_paths) {
      console.log(`Checking for files in: ${listenPath}`);
      
      try {
        const pendingFiles = await findPendingFiles(listenPath, cutoffDate);
        
        if (pendingFiles.length > 0) {
          console.log(`Found ${pendingFiles.length} files in ${listenPath}. Enqueuing for indexing...`);
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
  
  console.log('Stale file indexing job completed');
}

// Utility function for jobs
async function findPendingFiles(dirPath, cutoffDate) {
  const allFiles = await new fdir()
    .withFullPaths()
    .filter((filePath) => !shouldIgnoreFile(filePath))
    .crawl(dirPath)
    .withPromise();

  const pendingFiles = [];
  for (const filePath of allFiles) {
    try {
      const stats = await stat(filePath);
      // console.log(stats.mtime);
      // console.log(cutoffDate);
      if (stats.mtime < cutoffDate) {
        pendingFiles.push(filePath);
      }
    } catch (error) {
      console.warn(`Could not stat file ${filePath}:`, error.message);
    }
  }
  
  return pendingFiles;
}

export { enqueueStaleFiles };
