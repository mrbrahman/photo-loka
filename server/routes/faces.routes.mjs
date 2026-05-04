import { Router } from 'express';
import * as s from '../app/services.mjs';

const router = Router();

router.post('/recognizeFaces/:uuid', async function(req,res,next){
  try {
    const result = await s.ml.processFaceRecognition(req.params.uuid);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get('/getFaces/:uuid', async function(req,res,next){
  try {
    res.json(await s.ml.getFacesByUuid(req.params.uuid));
  } catch (error) {
    next(error);
  }
});

router.get('/getFacesByPerson', async function(req,res,next){
  try {
    res.json(await s.ml.getFacesByPerson(req.query.name));
  } catch (error) {
    next(error);
  }
});

router.put('/nameFaceCluster/:clusterId', async function(req,res,next){
  try {
    const count = await s.ml.nameFaceCluster(req.params.clusterId, req.body.name);
    res.json({ success: true, count });
  } catch (error) {
    next(error);
  }
});

router.put('/updatePersonName', async function(req,res,next){
  try {
    const count = await s.ml.updatePersonName(req.body.oldName, req.body.newName);
    res.json({ success: true, count });
  } catch (error) {
    next(error);
  }
});

router.get('/faceSuggestions/:clusterId', async function(req,res,next){
  try {
    res.json(await s.ml.getFaceSuggestions(req.params.clusterId));
  } catch (error) {
    next(error);
  }
});

router.get('/searchPersonNames', async function(req,res,next){
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json({ names: [] });
    const rows = await s.ml.searchPersonNames(q);
    res.json({ names: rows.map(r => r.person_name) });
  } catch (error) {
    next(error);
  }
});

router.put('/dismissFaceCluster/:clusterId', async function(req,res,next){
  try {
    await s.ml.dismissCluster(req.params.clusterId);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

export default router;
