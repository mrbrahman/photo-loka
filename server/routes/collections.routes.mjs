import { Router } from 'express';
import * as s from '../app/services.mjs';

const router = Router();

router.post('/createNewCollection', async function(req,res,next){
  let c = req.body;
  try {
    let id = await s.collections.createNewCollection(c)
    res.json(id)
  } catch (error){
    next(error);
  }
});

router.get('/getAllCollections', async function(req,res){
  res.json( await s.collections.getAllCollections() )
});

export default router;
