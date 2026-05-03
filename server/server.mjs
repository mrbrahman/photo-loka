import * as path from 'path';
import * as fs from 'fs';

import express from 'express';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import morgan from 'morgan';
import { createLogger } from './app/utils/logger.mjs';
import { AppError } from './app/utils/app-error.mjs';

import {startupConfig} from '#startup-config';
import {config, getRuntimeConfig, updateRuntimeConfig} from '#runtime-config';
import * as s from './app/services.mjs';
import { authenticateToken, authenticateMediaAccess } from './middleware/authn-middleware.mjs';
import * as authnService from './app/infrastructure/authn/authn-service.mjs';

const logger = createLogger(import.meta.url);



const app = express();

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(import.meta.dirname, '../web')));

morgan.token('query', (req) => JSON.stringify(req.query));
morgan.token('body', (req) => JSON.stringify(req.body));

const morganMiddleware = morgan(
  ':method :url :status :response-time ms - q::query b::body',
  {
    skip: (req) => 
         req.url.includes('/getThumbnail')
      || req.url.includes('getFaceThumbnail'),
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
// Authentication routes (no auth required)
// *****************************************
const authnRouter = express.Router();

authnRouter.post('/login', async function(req, res, next) {
  try {
    const { username, password } = req.body;
    const result = await authnService.login(username, password);
    
    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: startupConfig.nodeEnv === 'production',
      sameSite: 'strict',
      maxAge: 30 * 24 * 60 * 60 * 1000
    });
    
    res.json({ accessToken: result.accessToken, user: result.user });
  } catch (error) {
    next(error);
  }
});

authnRouter.post('/refresh', async function(req, res, next) {
  try {
    const refreshToken = req.cookies.refreshToken;
    if (!refreshToken) {
      throw new AppError('Refresh token required', 'NO_REFRESH_TOKEN', 'NO_REFRESH_TOKEN', 401);
    }
    
    const result = authnService.refreshAccessToken(refreshToken);
    
    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: startupConfig.nodeEnv === 'production',
      sameSite: 'strict',
      maxAge: 30 * 24 * 60 * 60 * 1000
    });
    
    res.json({ accessToken: result.accessToken, user: result.user });
  } catch (error) {
    res.clearCookie('refreshToken');
    next(error);
  }
});

authnRouter.post('/logout', function(req, res) {
  const refreshToken = req.cookies.refreshToken;
  authnService.logout(refreshToken);
  res.clearCookie('refreshToken');
  res.sendStatus(200);
});

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
apiRouter.get('/getAll', compression(), async function(req,res,next){
  try {
    res.json(await s.search.getAllFromDefaultCollection());
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/getThumbnail', authenticateMediaAccess, function(req,res){
  let uuid = req.query.uuid, height = +req.query.height;

  // TODO: get the list of sizes from indexer / thumbnail generator
  let thumbHeight = [100, 250, 500].filter(x=> x >= height)[0] || 500;

  // console.log(`inputs: uuid ${uuid} height ${height}`)
  let fileName = path.join(startupConfig.thumbsDir, ...Array.from(uuid).slice(0,3), `${uuid}_${thumbHeight}_fit.jpg`);
  // console.log(`getting thumbnail: ${fileName}`)
  res.sendFile(fileName);
});

apiRouter.get('/getImage', authenticateMediaAccess, async function(req,res){
  let uuid = req.query.uuid, height = +req.query.height, width = +req.query.width;
  
  res.type('image/jpg');
  // res.set({
  //   "Content-Disposition": `inline;filename="${filename.split(/\//).pop()}"`
  // });

  // (await s.thumbnails.getImage(uuid, width, height)).pipe(res);
  (await s.thumbnails.getImage(uuid, 1920, 1080)).pipe(res);
});


apiRouter.get('/getVideo', authenticateMediaAccess, async function(req, res, next){
  let uuid = req.query.uuid;
  let quality = req.query.quality || 'compressed';

  try {
    const { filePath, fileSize } = await s.videos.getVideoInfo(uuid, quality);
    const range = req.headers.range;
    const contentType = filePath.endsWith('.webm') ? 'video/webm' : 'video/mp4';

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.status(206);
      res.set({
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
      });

      const stream = s.videos.streamVideoRange(filePath, start, end);
      stream.pipe(res);
    } else {
      res.set({
        'Content-Length': fileSize,
        'Content-Type': contentType,
      });
      const stream = s.videos.streamVideoRange(filePath, 0, fileSize - 1);
      stream.pipe(res);
    }
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/search', compression(), async function(req,res,next){
  try {
    let {collection_id, searchText} = req.body;
    res.json(await s.search.search(collection_id, searchText));
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/getItemInfo', async function(req,res,next){
  try {
    let uuid = req.query.uuid;
    let info = await s.search.getItemInfo(uuid);
    if (!info) return res.status(404).json({error: {message: 'Item not found'}});
    res.json(info);
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/getFaceThumbnail', authenticateMediaAccess, async function(req,res,next){
  try {
    let {uuid, cluster_id} = req.query;
    let filePath = path.join(startupConfig.facesDir, cluster_id, `${uuid}.jpg`);
    if (!fs.existsSync(filePath)) return res.status(404).end();
    res.sendFile(path.resolve(filePath));
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/getGpsCoordinates', compression(), async function(req,res){
  res.json(await s.search.getGpsCoordinates());
});

apiRouter.get('/searchForExistingAlbums', async function(req,res){
  res.json(await s.albums.searchForExistingAlbums(req.query.searchStr, req.query.wantFullName))
});

apiRouter.post('/searchByGpsCoordinates', async function(req,res){
  let {collection_id, bounds} = req.body;
  res.json(await s.search.searchByGpsCoordinates(collection_id, bounds));
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

apiRouter.post('/refreshMetadataForItem/:uuid', async function(req,res,next){
  try {
    await s.metadataUpdates.refreshMetadata(req.params.uuid);
    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
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

apiRouter.put('/updateDescription', function(req,res,next){
  let {uuid, description} = req.body;
  try {
    s.metadataUpdates.updateDescription(uuid, description);
    res.sendStatus(200);
  } catch(err) {
    next(err);
  }
});

apiRouter.put('/renameFile', async function(req,res,next){
  let {collection_id, uuid, newBasename} = req.body;
  try {
    await s.itemActions.renameFile(collection_id, uuid, newBasename);
    res.sendStatus(200);
  } catch(err) {
    next(err);
  }
});

apiRouter.put('/refreshThumbs/:uuid', async function(req,res,next){
  try {
    await s.thumbnails.refreshThumbs(req.params.uuid);
    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});

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

apiRouter.get('/getTrashedItems', compression(), async function(req,res,next){
  try {
    let collection_id = req.query.collection_id;
    res.json(await s.search.getTrashedItems(collection_id));
  } catch (error) {
    next(error);
  }
});

apiRouter.delete('/trashItems', async function(req,res,next){
  try {
    let {collection_id, uuid_arr} = req.body;
    await s.itemActions.moveToTrash(collection_id, uuid_arr);
    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});

apiRouter.put('/togglePrivate', async function(req,res,next){
  try {
    let {collection_id, uuid_arr, makePrivate} = req.body;
    await s.itemActions.togglePrivate(collection_id, uuid_arr, makePrivate);
    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});

apiRouter.put('/restoreFromTrash', async function(req,res,next){
  try {
    let {collection_id, uuid_arr} = req.body;
    await s.itemActions.restoreFromTrash(collection_id, uuid_arr);
    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});

apiRouter.delete('/cleanupTrash', async function(req,res,next){
  try {
    let {collection_id, uuid_arr} = req.body;
    await s.itemActions.cleanupTrash(collection_id, uuid_arr);
    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});

apiRouter.delete('/emptyTrash', async function(req,res,next){
  try {
    let {collection_id, uuid_arr} = req.body;
    await s.itemActions.cleanupTrash(collection_id, uuid_arr);
    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});

apiRouter.put('/moveItems', async function(req,res,next){
  try {
    let {collection_id, uuid_arr, new_album_name} = req.body;
    await s.albums.moveItemsToAlbum(collection_id, uuid_arr, new_album_name);
    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
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

apiRouter.post('/pauseFrame/:frame_id', async function(req,res,next){
  try {
    await s.frame.pauseFrame(req.params.frame_id, req.body.pauseEndOverride);
    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/resumeFrame/:frame_id', async function(req,res,next){
  try {
    await s.frame.resumeFrame(req.params.frame_id);
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

// SSE endpoint for frame notifications
const frameSSEClients = new Map();

frameRouter.get('/events', function(req,res){
  const ip = req.ip.startsWith('::ffff:') ? req.ip.substring(7) : req.ip;
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  
  // Send initial connection message
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  
  frameSSEClients.set(ip, res);
  logger.info(`SSE client connected: ${ip}`);
  
  req.on('close', () => {
    frameSSEClients.delete(ip);
    logger.info(`SSE client disconnected: ${ip}`);
  });
});

// Listen to frame events and notify via SSE
s.frame.frameEvents.on('frame-resumed', ({frame_ip_addr}) => {
  const client = frameSSEClients.get(frame_ip_addr);
  if (client) {
    client.write(`data: ${JSON.stringify({ type: 'resume' })}\n\n`);
    logger.info(`Sent resume event to frame: ${frame_ip_addr}`);
  } else {
    logger.warn(`No SSE client found for frame: ${frame_ip_addr}`);
  }
});

s.frame.frameEvents.on('frame-paused', ({frame_ip_addr}) => {
  const client = frameSSEClients.get(frame_ip_addr);
  if (client) {
    client.write(`data: ${JSON.stringify({ type: 'pause' })}\n\n`);
    logger.info(`Sent pause event to frame: ${frame_ip_addr}`);
  } else {
    logger.warn(`No SSE client found for frame: ${frame_ip_addr}`);
  }
});

// *****************************************
// face recognition (ML)
// *****************************************

apiRouter.post('/recognizeFaces/:uuid', async function(req,res,next){
  try {
    const result = await s.ml.processFaceRecognition(req.params.uuid);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/getFaces/:uuid', async function(req,res,next){
  try {
    res.json(await s.ml.getFacesByUuid(req.params.uuid));
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/getFacesByPerson', async function(req,res,next){
  try {
    res.json(await s.ml.getFacesByPerson(req.query.name));
  } catch (error) {
    next(error);
  }
});

apiRouter.put('/nameFaceCluster/:clusterId', async function(req,res,next){
  try {
    const count = await s.ml.nameFaceCluster(req.params.clusterId, req.body.name);
    res.json({ success: true, count });
  } catch (error) {
    next(error);
  }
});

apiRouter.put('/updatePersonName', async function(req,res,next){
  try {
    const count = await s.ml.updatePersonName(req.body.oldName, req.body.newName);
    res.json({ success: true, count });
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/faceSuggestions/:clusterId', async function(req,res,next){
  try {
    res.json(await s.ml.getFaceSuggestions(req.params.clusterId));
  } catch (error) {
    next(error);
  }
});

apiRouter.put('/dismissFaceCluster/:clusterId', async function(req,res,next){
  try {
    await s.ml.dismissCluster(req.params.clusterId);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// *****************************************
// runtime config
// *****************************************

apiRouter.get('/getConfig', function(req,res){
  res.json(getRuntimeConfig());
});

apiRouter.put('/updateConfig', function(req,res,next){
  try {
    const {key, value} = req.body;
    updateRuntimeConfig(key, value);
    res.json({ key, value: config[key] });
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

app.get('/speed-test', (req, res) => {
  // Send 1MB of random data
  const buffer = Buffer.alloc(1024 * 1024);
  res.set('Content-Type', 'application/octet-stream');
  res.send(buffer);
});


app.get('/ping', (req, res) => {
  res.status(204).end(); // No content, just a header response
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

// Mount the authn router at /api/authn (no auth required)
app.use('/api/authn', authnRouter);

// Mount the frame router at /frame (no auth required)
app.use('/frame', frameRouter);

// Mount the API router at /api (auth required)
app.use('/api', authenticateToken, apiRouter);

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Error:', err);
  if (err instanceof AppError) {
    res.status(err.statusCode || 500).json({
      error: { code: err.code, message: err.message, info: err.info }
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
  // Close all SSE connections
  logger.info(`Closing ${frameSSEClients.size} SSE connection(s)...`);
  for (const [ip, client] of frameSSEClients.entries()) {
    client.end();
  }
  frameSSEClients.clear();
  
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
