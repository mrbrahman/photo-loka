import { Router } from 'express';
import * as s from '../app/services.mjs';

const router = Router();

// Body: { collection_id, album_date, currAlbumName, newAlbumName }
// Renames an album within a single day. The caller identifies the source
// folder by (album_date, currAlbumName); the destination keeps the same
// album_date and uses newAlbumName.
router.post('/updateAlbumName', async function(req,res,next){
  let {collection_id, album_date, currAlbumName, newAlbumName} = req.body;

  try {
    let updates = await s.albums.updateAlbum(collection_id, album_date, currAlbumName, newAlbumName);
    res.json(updates);
  } catch (err) {
    next(err);
  }
});

// Body: { collection_id, uuid_arr, target_album_date, target_album_name }
// Moves selected items into the (target_album_date, target_album_name)
// bucket. The album folder is created if it doesn't exist.
router.put('/moveItems', async function(req,res,next){
  try {
    let {collection_id, uuid_arr, target_album_date, target_album_name} = req.body;
    await s.albums.moveItemsToAlbum(collection_id, uuid_arr, target_album_date, target_album_name);
    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});

export default router;
