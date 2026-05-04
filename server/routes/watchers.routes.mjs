import { Router } from 'express';
import * as s from '../app/services.mjs';

const router = Router();

// TODO Implement start and stop for individual collection

router.post('/startAllWatchers', function(req,res){
  s.watcher.startWatchersForAllCollections();
  res.sendStatus(200);
});

router.post('/stopAllWatchers', function(req,res){
  s.watcher.stopAllWatchers();
  res.sendStatus(200);
});

export default router;
