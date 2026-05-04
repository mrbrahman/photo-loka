import { Router } from 'express';
import * as s from '../app/services.mjs';

const router = Router();

router.put('/updateRating', function(req,res,next){
  let {uuid_arr, newRating} = req.body;
  try{
    s.metadataUpdates.updateRating(uuid_arr, newRating);
    res.sendStatus(200);
  } catch(err){
    next(err);
  }
});

router.put('/updateDescription', function(req,res,next){
  let {uuid, description} = req.body;
  try {
    s.metadataUpdates.updateDescription(uuid, description);
    res.sendStatus(200);
  } catch(err) {
    next(err);
  }
});

router.put('/renameFile', async function(req,res,next){
  let {collection_id, uuid, newBasename} = req.body;
  try {
    await s.itemActions.renameFile(collection_id, uuid, newBasename);
    res.sendStatus(200);
  } catch(err) {
    next(err);
  }
});

router.put('/refreshThumbs/:uuid', async function(req,res,next){
  try {
    await s.thumbnails.refreshThumbs(req.params.uuid);
    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});

router.put('/compressVideo/:uuid', async function(req,res,next){
  try{
    await s.videos.compressVideo(req.params.uuid);
    res.sendStatus(200);
  } catch (err) {
    next(err);
  }
});

router.delete('/trashItems', async function(req,res,next){
  try {
    let {collection_id, uuid_arr} = req.body;
    await s.itemActions.moveToTrash(collection_id, uuid_arr);
    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});

router.put('/togglePrivate', async function(req,res,next){
  try {
    let {collection_id, uuid_arr, makePrivate} = req.body;
    await s.itemActions.togglePrivate(collection_id, uuid_arr, makePrivate);
    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});

router.put('/restoreFromTrash', async function(req,res,next){
  try {
    let {collection_id, uuid_arr} = req.body;
    await s.itemActions.restoreFromTrash(collection_id, uuid_arr);
    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});

router.delete('/cleanupTrash', async function(req,res,next){
  try {
    let {collection_id, uuid_arr} = req.body;
    await s.itemActions.cleanupTrash(collection_id, uuid_arr);
    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});

router.delete('/emptyTrash', async function(req,res,next){
  try {
    let {collection_id, uuid_arr} = req.body;
    await s.itemActions.cleanupTrash(collection_id, uuid_arr);
    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});

export default router;
