import * as path from 'path';

const config = {};

// set defaults

// monitor files
config.startFileWatcherAtStartup = false;  // immediate indexing
config.scanFilesForChangesAndIndexAtStartup = false;
config.filesDeletedThreshold = 5;

// nightly indexing
config.enableNightlyIndexing = true;
config.staleDays = 30;

// indexer
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

// geonames API rate limiting
config.geonamesHourlyLimit = 1000;
config.geonamesDailyLimit = 10000;

// video compression
// VP8: 'libvpx' (software), VP9: 'libvpx-vp9' (software)
// VP8 Hardware: 'vp8_nvenc'(NVIDIA) - rare
// VP9 Hardware: 'vp9_nvenc'(NVIDIA)/'vp9_qsv'(Intel)/'vp9_amf'(AMD) - limited support
// H.264 Hardware: 'h264_nvenc'(NVIDIA)/'h264_qsv'(Intel)/'h264_amf'(AMD) - widely supported
// H.265/HEVC Hardware: 'hevc_nvenc'(NVIDIA)/'hevc_qsv'(Intel)/'hevc_amf'(AMD) - better compression than H.264
// AV1: 'libaom-av1'(software)/'av1_nvenc'(NVIDIA RTX40+)/'av1_qsv'(Intel Arc) - future codec, best compression
config.videoEncoder = 'libvpx'; 
// videoContainer auto-determined: webm for VP8/VP9, mp4 for H.264/H.265/AV1


// TODO: store and and read these from db?

export {config};
