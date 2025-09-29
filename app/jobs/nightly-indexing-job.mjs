import { findPendingFiles } from '../infrastructure/scheduler.mjs';
import { getAllCollections } from '../core/collections/collection-manager.mjs';
import { bulkAddToIndexQueue } from '../core/indexing/queue-manager.mjs';
import { indexFile } from '../core/indexing/indexing-orchestrator.mjs';
import { config } from '../config.mjs';

export async function run() {
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