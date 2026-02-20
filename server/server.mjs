import * as path from 'path';

import express from 'express';
import compression from 'compression';
import morgan from 'morgan';
import { createLogger } from './app/utils/logger.mjs';

import {config} from './app/config.mjs';
import * as s from './app/services.mjs'

const logger = createLogger(import.meta.url);



const app = express();

app.use(compression());
app.use(express.json());
app.use(express.static(path.join(import.meta.dirname, '../web')));

morgan.token('query', (req) => JSON.stringify(req.query));
morgan.token('body', (req) => JSON.stringify(req.body));

const morganMiddleware = morgan(
  ':method :url :status :response-time ms - q::query b::body',
  {
    skip: (req) => 
         req.url.includes('/getThumbnail'),
      // || req.url.includes('/getImage')
      // || req.url.includes('/getVideo')
      // || req.url.includes('/getNext')
      // || req.url.includes('/getPrev'),
    stream: {
        write: (message) => logger.info(message.trim()),
    },
  }
);


app.use(morganMiddleware);

// *****************************************
// API router with /api prefix
// *****************************************
const apiRouter = express.Router();

const frameRouter = express.Router();

// TODO: validate request parameters in all relevant functions?

// *****************************************
// search, and thumbnails
// *****************************************

// TODO: rename this
apiRouter.get('/getAll', async function(req,res){
  res.json(await s.search.getAllFromDefaultCollection());
});

apiRouter.get('/getThumbnail', function(req,res){
  let uuid = req.query.uuid, height = +req.query.height;

  // TODO: get the list of sizes from indexer / thumbnail generator
  let thumbHeight = [100, 250, 500].filter(x=> x >= height)[0];

  // console.log(`inputs: uuid ${uuid} height ${height}`)
  let fileName = path.join(config.thumbsDir, ...Array.from(uuid).slice(0,3), `${uuid}_${thumbHeight}_fit.jpg`);
  // console.log(`getting thumbnail: ${fileName}`)
  res.sendFile(fileName, {root: '.'});
});

apiRouter.get('/getImage', async function(req,res){
  let uuid = req.query.uuid, height = +req.query.height, width = +req.query.width;
  
  res.type('image/jpg');
  // res.set({
  //   "Content-Disposition": `inline;filename="${filename.split(/\//).pop()}"`
  // });

  // (await s.thumbnails.getImage(uuid, width, height)).pipe(res);
  (await s.thumbnails.getImage(uuid, 1920, 1080)).pipe(res);
});


apiRouter.get('/getVideo', async function(req,res){
  let uuid = req.query.uuid, height = +req.query.height, width = +req.query.width;

  (await s.videos.getVideo(uuid)).pipe(res);

});

apiRouter.post('/search', async function(req,res){
  let {collection_id, searchText} = req.body;
  res.json(await s.search.search(collection_id, searchText));
});

apiRouter.get('/getGpsCoordinates', async function(req,res){
  res.json(await s.search.getGpsCoordinates());
});

apiRouter.get('/searchForExistingAlbums', async function(req,res){
  res.json(await s.albums.searchForExistingAlbums(req.query.searchStr, req.query.wantFullName))
});

apiRouter.post('/searchByGpsCoordinates', async function(req,res){
  let {collection_id, coordinates} = req.body;
  res.json(await s.search.searchByGpsCoordinates(collection_id, coordinates));
});

// *****************************************
// collection functions
// *****************************************
apiRouter.post('/createNewCollection', async function(req,res,next){
  let c = req.body;
  try {
    let id = await s.collections.createNewCollection(c)
    res.json(id)
  } catch (error){
    next(error);
  }
});

apiRouter.get('/getAllCollections', async function(req,res){
  res.json( await s.collections.getAllCollections() )
});


// *****************************************
// indexer functions
// *****************************************

apiRouter.post('/startIndexingFirstTime', async function(req,res){
  let {collection_id} = req.query;
  s.bulkIndexer.indexCollection(collection_id, true);
  res.sendStatus(200);
});

apiRouter.post('/indexCollection/:collection_id', function(req,res){
  let collection_id = req.params.collection_id;
  s.bulkIndexer.indexCollection(collection_id);
  res.sendStatus(200);
});

apiRouter.post('/startIntakeFileIndexing', async function(req,res,next){
  let {collection_id, dir, staleDays} = req.body;
  try {
    await s.newFilesIndexer.startIntakeFileIndexing(collection_id, dir, staleDays);
    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});

// *****************************************
// indexer control functions
// *****************************************

apiRouter.get('/getIndexerStatus', function(req,res){
  res.json(s.indexer.indexerStatus());
});

apiRouter.put('/pauseIndexer', function(req,res){
  s.indexer.pauseIndexer();
  res.sendStatus(200);
});

apiRouter.put('/resumeIndexer', function(req,res){
  s.indexer.resumeIndexer();
  res.sendStatus(200);
});

apiRouter.get('/getIndexerErrors', function(req,res){
  res.json( s.indexer.indexerErrors )
});

apiRouter.put('/updateIndexerConcurrency/:concurrency', function(req,res,next){
  let concurrency = +req.params.concurrency;

  if(concurrency){
    s.indexer.updateIndexerConcurrency(concurrency);
  }
  res.sendStatus(200);
});

apiRouter.post('/refreshMetadataForCollection/:collection_id', function(req,res){
  let collection_id = +req.params.collection_id;
  s.bulkIndexer.refreshMetadataForCollection(collection_id);
  res.sendStatus(200);
});

apiRouter.post('/refreshMetadataForItem/:uuid', async function(req,res){
  await s.metadataUpdates.refreshMetadata(req.params.uuid);
  res.sendStatus(200);
});


apiRouter.put('/updateRating', function(req,res,next){
  let {uuid_arr, newRating} = req.body;
  try{
    s.metadataUpdates.updateRating(uuid_arr, newRating);
    res.sendStatus(200);
  } catch(err){
    next(err);
  }
});

apiRouter.put('/refreshThumbs/:uuid', async function(req,res){
  await s.thumbnails.refreshThumbs(req.params.uuid);
  res.sendStatus(200);
})

apiRouter.put('/compressVideo/:uuid', async function(req,res,next){
  try{
    await s.videos.compressVideo(req.params.uuid);
    res.sendStatus(200);
  } catch (err) {
    next(err);
  }
})

// *****************************************
// reverse geo encoding
// *****************************************
apiRouter.get('/getReverseGeoEncodingStatus', function(req,res){
  res.json(s.geoEncoder.status());
});

apiRouter.post('/enqueueReverseGeoEncoding', function(req,res){
  let {uuid, gps_lat, gps_long} = req.body;
  if (uuid && gps_lat && gps_long){
    s.geoEncoder.enqueue(uuid, gps_lat, gps_long);
  }
  res.sendStatus(200);
});

apiRouter.post('/enqueueManyReverseGeoEncoding', function(req,res){
  let entries = req.body;
  s.geoEncoder.enqueueMany(entries);
  res.sendStatus(200);
});

// *****************************************
// album organization
// *****************************************
apiRouter.post('/updateAlbumName', async function(req,res,next){
  let {collection_id, currAlbumName, newAlbumName} = req.body;

  try {
    let updates = await s.albums.updateAlbum(collection_id, currAlbumName, newAlbumName);
    res.json(updates);
  } catch (err) {
    next(err);
  }

});

apiRouter.delete('/trashItems', async function(req,res){
  let {collection_id, uuid_arr} = req.body;
  await s.fileOps.moveFileToTrash(collection_id, uuid_arr);
  res.sendStatus(200);
});

apiRouter.put('/moveItems', async function(req,res){
  let {collection_id, uuid_arr, new_album_name} = req.body;
  await s.albums.moveItemsToAlbum(collection_id, uuid_arr, new_album_name);
  res.sendStatus(200);
});

// *****************************************
// frame management
// *****************************************

apiRouter.post('/createNewFrame', async function(req,res,next){
  let entry = req.body;
  try {
    let frame_id = await s.frame.createNewFrame(entry);
    res.json({ frame_id });
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/loadAllFrames', async function(req,res,next){
  try {
    await s.frame.loadAllFrames();
    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/getAllFrames', async function(req,res,next){
  try {
    res.json(await s.frame.getAllFrames());
  } catch (error) {
    next(error);
  }
});

apiRouter.put('/updateFrame/:frame_id', async function(req,res,next){
  try {
    await s.frame.updateFrame(req.params.frame_id, req.body);
    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});

apiRouter.delete('/deleteFrame/:frame_id', async function(req,res,next){
  try {
    await s.frame.deleteFrame(req.params.frame_id);
    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});


frameRouter.get('/getNext', function(req,res,next){
  const ip = req.ip.startsWith('::ffff:') ? req.ip.substring(7) : req.ip;
  try {
    let item = s.frame.getNextItem(ip);
    res.json(item);
  } catch (error) {
    next(error);
  }
});


frameRouter.get('/getPrev', function(req,res,next){
  const ip = req.ip.startsWith('::ffff:') ? req.ip.substring(7) : req.ip;
  try {
    let item = s.frame.getPrevItem(ip);
    res.json(item);
  } catch (error) {
    next(error);
  }
});

// *****************************************
// watchers
// *****************************************

// TODO Implement start and stop for individual collection

apiRouter.post('/startAllWatchers', function(req,res){
  s.watcher.startWatchersForAllCollections();
  res.sendStatus(200);
});

apiRouter.post('/stopAllWatchers', function(req,res){
  s.watcher.stopAllWatchers();
  res.sendStatus(200);
});

// *****************************************
// scheduled indexing
// *****************************************

apiRouter.post('/startScheduledIndexing', function(req,res){
  s.jobs.startScheduledIndexing();
  res.sendStatus(200);
});

apiRouter.post('/stopScheduledIndexing', function(req,res){
  s.jobs.stopScheduledIndexing();
  res.sendStatus(200);
});

// *****************************************
// backup functions
// *****************************************

apiRouter.post('/backupToConnectedDevices', async function(req,res,next){
  let dryRun = req.query.dryRun === 'true';
  try {
    const results = await s.backup.backupToConnectedDevices(dryRun);
    res.json(results);
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/backupToDevice/:deviceId', async function(req,res,next){
  let dryRun = req.query.dryRun === 'true';
  let deviceId = req.params.deviceId;
  try {
    const results = await s.backup.backupToDevice(deviceId, dryRun);
    res.json(results);
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/getAllBackupRegistrations', async function(req,res,next){
  try {
    const registrations = await s.backup.getAllBackupRegistrations();
    res.json(registrations);
  } catch (error) {
    next(error);
  }
});



// TODO
// apiRouter.delete('/deleteAlbum/:albumName', function(req,res){
//   let albumName = req.params.albumName;
//   if(){ // album name is valid
//     s.indexer.deleteAlbum(albumName);
//     res.sendStatus(200);
//   } else {
//     ???
//   }
  
// })

// Mount the API router at /api
app.use('/api', apiRouter);

// Mount the frame router at /frame
app.use('/frame', frameRouter);

// Error handling middleware
app.use((err, req, res, next) => {
  if (err.name === 'AppError') {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message
      }
    });
  } else {
    res.status(500).json({
      error: {
        code: 'UNKNOWN_ERROR',
        message: err.message || 'An unexpected error occurred'
      }
    });
  }
});


// *****************************************
// start server
// *****************************************

process.on('SIGUSR2', function(){
  logger.info('***** Nodemon restart signal received **** ');
  handleServerShutdown();
});

process.on('SIGINT', function(){
  logger.info('***** Interrupt signal received **** ');
  handleServerShutdown();
});

process.on('SIGTERM', function(){
  logger.info('***** Terminate signal received **** ');
  handleServerShutdown();
});

const handleServerShutdown = async function(){
  await s.shutdown.shutdownCleanup();

  server.close(()=>{
    logger.info('app shutdown. Ending process... ');
    process.exit(0);
  });
}

let server = app.listen(9000, async ()=>{
  logger.info("app started and listening in port 9000!");
  // Perform startup activities
  await s.startup.startUpActivities();
});
