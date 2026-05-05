import { Router } from 'express';
import * as s from '../app/services.mjs';

const router = Router();

// *****************************************
// indexer functions
// *****************************************

router.post('/startIndexingFirstTime', async function(req,res){
  let {collection_id} = req.query;
  s.bulkIndexer.initialIndexing(collection_id);
  res.sendStatus(200);
});

router.post('/scanForChanges/:collection_id', function(req,res){
  let collection_id = req.params.collection_id;
  s.bulkIndexer.scanForChanges(collection_id);
  res.sendStatus(200);
});

router.post('/startIntakeFileIndexing', async function(req,res,next){
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

router.get('/getIndexerStatus', function(req,res){
  res.json(s.indexer.indexerStatus());
});

router.put('/pauseIndexer', function(req,res){
  s.indexer.pauseIndexer();
  res.sendStatus(200);
});

router.put('/resumeIndexer', function(req,res){
  s.indexer.resumeIndexer();
  res.sendStatus(200);
});

router.get('/getIndexerErrors', function(req,res){
  res.json( s.indexer.indexerErrors )
});

router.put('/updateIndexerConcurrency/:concurrency', function(req,res,next){
  let concurrency = +req.params.concurrency;

  if(concurrency){
    s.indexer.updateIndexerConcurrency(concurrency);
  }
  res.sendStatus(200);
});

router.post('/refreshMetadataForCollection/:collection_id', function(req,res){
  let collection_id = +req.params.collection_id;
  s.bulkIndexer.refreshMetadataForCollection(collection_id);
  res.sendStatus(200);
});

router.post('/refreshMetadataForItem/:uuid', async function(req,res,next){
  try {
    await s.metadataUpdates.refreshMetadata(req.params.uuid);
    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});

export default router;
