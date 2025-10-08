import {fdir} from 'fdir';
import { stat } from 'fs/promises';
import { createLogger } from '#utils/logger';

import { getAllCollections } from '#collections/collection-manager';
import { bulkAddToIndexQueue, indexerStatus } from './queue-manager.mjs';
import { indexFile } from './file-indexer.mjs';
import { shouldIgnoreFile } from '#utils/file-filters';
import { config } from '#config';

const logger = createLogger(import.meta.url);

async function enqueueStaleFiles() {
  logger.info('Starting stale file indexing...');

  // Skip if indexer is already running
  if (indexerStatus.processingCnt > 0 || indexerStatus.pendingCnt > 0) {
    logger.info('Indexer is currently running. Skipping stale file indexing.');
    return;
  }
  
  const collections = await getAllCollections();
  // Files older than this date will be indexed (mtime < cutoffDate)
  const cutoffDate = new Date(Date.now() - (config.staleDays * 24 * 60 * 60 * 1000));
  
  for (const collection of collections) {
    for (const listenPath of collection.listen_paths) {
      logger.info(`Checking for files in: ${listenPath}`);
      
      try {
        const pendingFiles = await findPendingFiles(listenPath, cutoffDate);
        
        if (pendingFiles.length > 0) {
          logger.info(`Found ${pendingFiles.length} files in ${listenPath}. Enqueuing for indexing...`);
	  logger.debug(JSON.stringify(pendingFiles, null, 2));
          bulkAddToIndexQueue(
            pendingFiles.map(f=>{
              return [indexFile, [collection, f, null, false]];
            })
          );
        }
      } catch (error) {
        logger.error(`Error checking files in ${listenPath}:`, error);
      }
    }
  }
  
  logger.info('Stale file indexing job completed');
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
      if (stats.mtime < cutoffDate) {
        pendingFiles.push(filePath);
      }
    } catch (error) {
      logger.warn(`Could not stat file ${filePath}:`, error.message);
    }
  }
  
  return pendingFiles;
}

export { enqueueStaleFiles };
