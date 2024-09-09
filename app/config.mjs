import * as path from 'path';

const config = {};

// set defaults

// monitor files
config.startFileWatcherAtStartup = false;
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
// config.albumNameChangesFile = path.join(config.dataDir, 'album_name_changes.txt')

// audit file change information
// will help if changes (e.g. rename folders, move files) needs to be synced to multiple hard drives
config.auditFiles = true;

// TODO: read & write a yml / json5 file specified as parameter? or node env?

export {config};
