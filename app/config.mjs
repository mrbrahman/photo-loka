import * as path from 'path';

const config = {};

// set defaults

// monitor files
config.startFileWatcherAtStartup = true;
config.scanFilesForChangesAndIndexAtStartup = false;
config.filesDeletedThreshold = 5;

// indexer
config.indexerDbUpdateTimeout = 3000;
config.indexerDbUpdateChunk =  500;
config.maxIndexerConcurrency = 1;

// dirs
config.dataDir = 'data';
config.thumbsDir = path.join(config.dataDir, 'thumbnails');
config.facesDir = path.join(config.dataDir, 'faces');

// db file
config.dbFile = path.join(config.dataDir, 'MEMORIES-DATABASE.sqlite')

// album name change file (file to track album name changes)
config.albumNameChangesFile = path.join(config.dataDir, 'album_name_changes.txt')

// TODO: read & write a yml / json5 file specified as parameter? or node env?

export {config};
