import { Router } from 'express';
import compression from 'compression';
import * as s from '../app/services.mjs';

const router = Router();

// TODO: rename this
router.get('/getAll', compression(), async function(req,res,next){
  try {
    res.json(await s.search.getAllFromDefaultCollection());
  } catch (error) {
    next(error);
  }
});

router.post('/search', compression(), async function(req,res,next){
  try {
    let {collection_id, searchText} = req.body;
    res.json(await s.search.search(collection_id, searchText));
  } catch (error) {
    next(error);
  }
});

router.get('/getItemInfo', async function(req,res,next){
  try {
    let uuid = req.query.uuid;
    let info = await s.search.getItemInfo(uuid);
    if (!info) return res.status(404).json({error: {message: 'Item not found'}});
    res.json(info);
  } catch (error) {
    next(error);
  }
});

router.get('/getGpsCoordinates', compression(), async function(req,res){
  res.json(await s.search.getGpsCoordinates());
});

router.get('/searchForExistingAlbums', async function(req,res){
  res.json(await s.albums.searchForExistingAlbums(req.query.searchStr, req.query.wantFullName))
});

router.post('/searchByGpsCoordinates', async function(req,res){
  let {collection_id, bounds} = req.body;
  res.json(await s.search.searchByGpsCoordinates(collection_id, bounds));
});

router.get('/getTrashedItems', compression(), async function(req,res,next){
  try {
    let collection_id = req.query.collection_id;
    res.json(await s.search.getTrashedItems(collection_id));
  } catch (error) {
    next(error);
  }
});

export default router;
