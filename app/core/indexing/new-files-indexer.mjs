import {fdir} from 'fdir';
import { stat } from 'fs/promises';
import { createLogger } from '#utils/logger';

import { getCollection, getCollectionByIntakePath } from '#collections/collection-manager';
import { bulkAddToIndexQueue, indexerStatus } from './queue-manager.mjs';
import { indexFile } from './file-indexer.mjs';
import { shouldIgnoreFile } from '#utils/file-filters';
import { config } from '#config';

const logger = createLogger(import.meta.url);

export async function startNewFileIndexing(collection_id, dir, staleDays = null) {
  try {
    if (collection_id && dir) {
      // Run for specific dir in specific collection
      const collection = await getCollection(collection_id);
      enqueueNewFiles(collection, dir, staleDays);
    } else if (dir) {
      // Find collection that contains this dir
      const foundCollection = await getCollectionByIntakePath(dir);
      
      if (foundCollection) {
        // Find the specific intake config for staleDays
        const intakeConfig = foundCollection.intake_configs.find(config => config.path === dir);
        staleDays = staleDays || intakeConfig?.config?.staleDays;
        enqueueNewFiles(foundCollection, dir, staleDays);
      } else {
        return res.status(400).json({error: `Directory ${dir} not found in any collection`});
      }
    } else if (collection_id) {
      // Run for all scheduled intake paths in collection
      const collection = await getCollection(collection_id);
      
      for (const intakeConfig of collection.intake_configs) {
        if (intakeConfig.method === 'scheduled') {
          const configStaleDays = staleDays ?? intakeConfig.config?.staleDays ?? config.staleDays;
          enqueueNewFiles(collection, intakeConfig.path, configStaleDays);
        }
      }
    } else {
      throw 'Either collection_id or dir must be provided';
    }
    
  } catch (error) {
    throw error;
  }

}

async function enqueueNewFiles(collection, dirPath, staleDays = null) {
  logger.info(`Starting new file indexing for: ${dirPath}`);

  // Skip if indexer is already running
  if (indexerStatus.processingCnt > 0 || indexerStatus.pendingCnt > 0) {
    logger.warn('Indexer is currently running. Skipping new file indexing.');
    return;
  }
  
  const days = staleDays ?? config.staleDays;
  const cutoffDate = new Date(Date.now() - (days * 24 * 60 * 60 * 1000));
  
  try {
    const pendingFiles = await findPendingFiles(dirPath, cutoffDate);
    
    if (pendingFiles.length > 0) {
      logger.info(`Found ${pendingFiles.length} files in ${dirPath}. Enqueuing for indexing...`);
      logger.info(JSON.stringify(pendingFiles, null, 2));
      
      bulkAddToIndexQueue(
        pendingFiles.map(f=>{
          return [indexFile, [collection, f, null, false]];
        })
      );
    }
  } catch (error) {
    logger.error(`Error checking files in ${dirPath}:`, error);
  }
  
  logger.info('New files (if any) are enqueued for indexing.');
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

export { enqueueNewFiles };
