import { Router } from 'express';
import * as s from '../app/services.mjs';

const router = Router();

router.post('/startScheduledIndexing', function(req,res){
  s.jobs.startScheduledIndexing();
  res.sendStatus(200);
});

router.post('/stopScheduledIndexing', function(req,res){
  s.jobs.stopScheduledIndexing();
  res.sendStatus(200);
});

export default router;
