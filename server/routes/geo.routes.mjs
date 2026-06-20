import { Router } from 'express';
import * as s from '../app/services.mjs';

const router = Router();

router.get('/getReverseGeoEncodingStatus', function(req,res){
  res.json(s.geoEncoder.status());
});

router.post('/enqueueReverseGeoEncoding', function(req,res){
  let {uuid} = req.body;
  if (uuid){
    s.geoEncoder.enqueue(uuid);
  }
  res.sendStatus(200);
});

router.post('/enqueueManyReverseGeoEncoding', function(req,res){
  let entries = req.body;
  s.geoEncoder.enqueueMany(entries);
  res.sendStatus(200);
});

export default router;
