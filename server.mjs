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

const { format } = winston;
const logger = winston.createLogger({
  format: format.combine(
    format.colorize(),
    format.timestamp(),
    format.printf((msg) => {
      return `${msg.timestamp} [${msg.level}] ${msg.message}`;
    })
  ),
  transports: [new winston.transports.Console({level: 'http'})],
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

// TODO: validate request parameters in all relevant functions?

// *****************************************
// search, and thumbnails
// *****************************************

// TODO: rename this
app.get('/getAll', function(req,res){
  res.json(s.search.getAllFromDefaultCollection());
});

app.get('/getThumbnail', function(req,res){
  let uuid = req.query.uuid, height = +req.query.height;

  // TODO: get the list of sizes from indexer / thumbnail generator
  let thumbHeight = [100, 250, 500].filter(x=> x >= height)[0];

  // console.log(`inputs: uuid ${uuid} height ${height}`)
  let fileName = path.join(config.thumbsDir, ...Array.from(uuid).slice(0,3), `${uuid}_${thumbHeight}_fit.jpg`);
  // console.log(`getting thumbnail: ${fileName}`)
  res.sendFile(fileName, {root: '.'});
});

app.get('/getImage', function(req,res){
  let uuid = req.query.uuid, height = +req.query.height, width = +req.query.width;
  
  res.type('image/jpg');
  // res.set({
  //   "Content-Disposition": `inline;filename="${filename.split(/\//).pop()}"`
  // });

  s.search.getImage(uuid, width, height).pipe(res);
});


app.get('/getVideo', function(req,res){
  let uuid = req.query.uuid, height = +req.query.height, width = +req.query.width;

  s.search.getVideo(uuid).pipe(res);

});

app.post('/search', function(req,res){
  let {collection_id, searchText} = req.body;
  res.json(s.search.search(collection_id, searchText));
});

app.get('/searchForExistingAlbums', function(req,res){
  res.json(s.search.searchForExistingAlbums(req.query.searchStr, req.query.wantFullName))
})

// *****************************************
// collection functions
// *****************************************
app.post('/createNewCollection', function(req,res,next){
  let c = req.body;
  try {
    let id = s.collections.createNewCollection(c)
    res.json(id)
  } catch (error){
    next(error);
  }
});

app.get('/getAllCollections', function(req,res){
  res.json( s.collections.getAllCollections() )
});


// *****************************************
// indexer functions
// *****************************************

app.post('/startIndexingFirstTime', async function(req,res){
  let {collection_id} = req.query;
  s.indexer.indexCollection(collection_id, true);
  res.sendStatus(200);
});

app.post('/indexCollection/:collection_id', function(req,res){
  let collection_id = req.params.collection_id;
  s.indexer.indexCollection(collection_id);
  res.sendStatus(200);
});

app.get('/getIndexerStatus', function(req,res){
  res.json(s.indexer.indexerStatus());
});

app.put('/pauseIndexer', function(req,res){
  s.indexer.pauseIndexer();
  res.sendStatus(200);
});

app.put('/resumeIndexer', function(req,res){
  s.indexer.resumeIndexer();
  res.sendStatus(200);
});

app.get('/getIndexerErrors', function(req,res){
  res.json( s.indexer.indexerErrors )
});

app.put('/updateIndexerConcurrency/:concurrency', function(req,res,next){
  let concurrency = +req.params.concurrency;

  if(concurrency){
    s.indexer.updateIndexerConcurrency(concurrency);
  }
  res.sendStatus(200);
});

app.put('/updateRating', function(req,res){
  let {uuid_arr, newRating} = req.body;
  try{
    s.indexer.updateRating(uuid_arr, newRating);
  } catch(err){
    res.status(500).json({error: err.message});
    return;
  }
  res.sendStatus(200);
})

// *****************************************
// album organization
// *****************************************
app.post('/updateAlbumName', async function(req,res){
  let {collection_id, currAlbumName, newAlbumName} = req.body;

  try {
    let updates = await s.indexer.updateAlbum(collection_id, currAlbumName, newAlbumName);
    res.json(updates);
  } catch (err) {
    res.status(500).json({error: err});
  }

});

app.delete('/deleteFromCollection', function(req,res){
  let uuid_arr = req.body.uuid_arr;
  // TODO: Implement trash
  // s.indexer.deleteFromCollection(uuid_arr);
  res.sendStatus(200);
});

// TODO
// app.delete('/deleteAlbum/:albumName', function(req,res){
//   let albumName = req.params.albumName;
//   if(){ // album name is valid
//     s.indexer.deleteAlbum(albumName);
//     res.sendStatus(200);
//   } else {
//     ???
//   }
  
// })


// *****************************************
// start server
// *****************************************

process.on('SIGINT', function(){
  console.log('***** Interrupt signal received **** ');
  handleServerShutdown();
});

process.on('SIGTERM', function(){
  console.log('***** Terminate signal received **** ');
  handleServerShutdown();
});

const handleServerShutdown = async function(){
  await s.housekeeping.shutdownCleanup();

  server.close(()=>{
    console.log('app shutdown. Ending process... ');
    process.exit(0);
  });
}

let server = app.listen(9000, ()=>{
  console.log("app started and listening in port 9000!");
  // Perform startup activities
  s.housekeeping.startUpActivities();
});
