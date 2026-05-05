import { statfs } from 'fs/promises';
import * as db from './dashboard-db.mjs';

export async function getStats() {
  const [stats, collections] = await Promise.all([
    db.getLibraryStats(),
    db.getCollectionStats()
  ]);

  // Build byType from the consolidated query
  const byType = {};
  if (stats.imageCount > 0) byType.image = { count: stats.imageCount, size: stats.imageSize };
  if (stats.videoCount > 0) byType.video = { count: stats.videoCount, size: stats.videoSize };
  if (stats.audioCount > 0) byType.audio = { count: stats.audioCount, size: stats.audioSize };
  if (stats.otherCount > 0) byType.other = { count: stats.otherCount, size: stats.otherSize };

  // Get free disk space for each collection's path
  const collectionsWithDisk = await Promise.all(
    collections.map(async (c) => {
      let freeSpace = null;
      if (c.collection_path) {
        try {
          const fsStats = await statfs(c.collection_path);
          freeSpace = fsStats.bfree * fsStats.bsize;
        } catch (e) {
          // Path may not exist or be inaccessible
          freeSpace = null;
        }
      }
      return { ...c, freeSpace };
    })
  );

  return {
    totalItems: stats.totalItems,
    totalSize: stats.totalSize,
    albums: stats.albums,
    trashedItems: stats.trashedItems,
    byType,
    collections: collectionsWithDisk
  };
}
