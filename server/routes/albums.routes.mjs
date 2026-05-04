import { Router } from 'express';
import * as s from '../app/services.mjs';

const router = Router();

router.post('/updateAlbumName', async function(req,res,next){
  let {collection_id, currAlbumName, newAlbumName} = req.body;

  try {
    let updates = await s.albums.updateAlbum(collection_id, currAlbumName, newAlbumName);
    res.json(updates);
  } catch (err) {
    next(err);
  }

});

router.put('/moveItems', async function(req,res,next){
  try {
    let {collection_id, uuid_arr, new_album_name} = req.body;
    await s.albums.moveItemsToAlbum(collection_id, uuid_arr, new_album_name);
    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});

export default router;
