import * as path from 'path';

import express from 'express';
import compression from 'compression';
import morgan from 'morgan';
import winston from 'winston';

import {config} from './app/config.mjs';
import * as s from './app/services.mjs'

const app = express();

app.use(compression());
app.use(express.json());
app.use(express.static('public'));

// const requestFilter = (req) => {
//   // Customize your condition here, for example:
//   // Log only POST requests or requests to a specific path
//   // return req.method === 'POST' || req.url.startsWith('/api/specific-path');
//   return !req.url.startsWith('/getThumbnail');
// };

const { format } = winston;
const logger = winston.createLogger({
  format: format.combine(
    format.colorize(),
    format.timestamp(),
    format.printf((msg) => {
      return `${msg.timestamp} [${msg.level}] ${msg.message}`;
    })
  ),
  transports: [new winston.transports.Console({
    // format: winston.format.combine(
    //   winston.format((info) => {
    //       // Apply the filter to check if the log should be recorded
    //       // return requestFilter(info.req) ? info : null;
    //       return info
    //   })(),
    //   winston.format.colorize()
    // ),
    // level: 'http'
  })],
});

const morganMiddleware = morgan(
  ':method :url :status :res[content-length] - :response-time ms',
  {
    stream: {
        write: (message) => logger.http(message.trim()),
    },
  }
);

app.use(morganMiddleware);

// *****************************************
// API router with /api prefix
// *****************************************
const apiRouter = express.Router();

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
  s.batchIndexer.indexCollection(collection_id, true);
  res.sendStatus(200);
});

apiRouter.post('/indexCollection/:collection_id', function(req,res){
  let collection_id = req.params.collection_id;
  s.batchIndexer.indexCollection(collection_id);
  res.sendStatus(200);
});

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
  s.batchIndexer.refreshMetadataForCollection(collection_id);
  res.sendStatus(200);
});

apiRouter.post('/refreshMetadataForItem/:uuid', async function(req,res){
  await s.batchIndexer.refreshMetadata(req.params.uuid);
  res.sendStatus(200);
});


apiRouter.put('/updateRating', function(req,res){
  let {uuid_arr, newRating} = req.body;
  try{
    s.exif.updateRating(uuid_arr, newRating);
  } catch(err){
    res.status(500).json({error: err.message});
    return;
  }
  res.sendStatus(200);
});

apiRouter.put('/refreshThumbs/:uuid', async function(req,res){
  await s.thumbnails.refreshThumbs(req.params.uuid);
  res.sendStatus(200);
})

apiRouter.put('/compressVideo/:uuid', async function(req,res){
  await s.videos.compressVideo(req.params.uuid);
  res.sendStatus(200);
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
apiRouter.post('/updateAlbumName', async function(req,res){
  let {collection_id, currAlbumName, newAlbumName} = req.body;

  try {
    let updates = await s.albums.updateAlbum(collection_id, currAlbumName, newAlbumName);
    res.json(updates);
  } catch (err) {
    res.status(500).json(err);
  }

});

apiRouter.delete('/trashItems', async function(req,res){
  let {uuid_arr} = req.body;
  await s.fileOps.moveFileToTrash(uuid_arr);
  res.sendStatus(200);
});

apiRouter.put('/moveItems', async function(req,res){
  let {collection_id, uuid_arr, new_album_name} = req.body;
  await s.albums.moveItemsToAlbum(collection_id, uuid_arr, new_album_name);
  res.sendStatus(200);
});

// *****************************************
// wathers
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
// nightly indexing
// *****************************************

apiRouter.post('/startNightlyIndexing', function(req,res){
  s.jobs.startNightlyIndexing();
  res.sendStatus(200);
});

apiRouter.post('/stopNightlyIndexing', function(req,res){
  s.jobs.stopNightlyIndexing();
  res.sendStatus(200);
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


// *****************************************
// start server
// *****************************************

process.on('SIGUSR2', function(){
  console.log('***** Nodemon restart signal received **** ');
  handleServerShutdown();
});

process.on('SIGINT', function(){
  console.log('***** Interrupt signal received **** ');
  handleServerShutdown();
});

process.on('SIGTERM', function(){
  console.log('***** Terminate signal received **** ');
  handleServerShutdown();
});

const handleServerShutdown = async function(){
  await s.shutdown.shutdownCleanup();

  server.close(()=>{
    console.log('app shutdown. Ending process... ');
    process.exit(0);
  });
}

let server = app.listen(9000, async ()=>{
  console.log("app started and listening in port 9000!");
  // Perform startup activities
  await s.startup.startUpActivities();
});
