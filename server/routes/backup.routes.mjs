import { Router } from 'express';
import * as s from '../app/services.mjs';

const router = Router();

router.post('/backupToConnectedDevices', async function(req,res,next){
  let dryRun = req.query.dryRun === 'true';
  try {
    const results = await s.backup.backupToConnectedDevices(dryRun);
    res.json(results);
  } catch (error) {
    next(error);
  }
});

router.post('/backupToDevice/:deviceId', async function(req,res,next){
  let dryRun = req.query.dryRun === 'true';
  let deviceId = req.params.deviceId;
  try {
    const results = await s.backup.backupToDevice(deviceId, dryRun);
    res.json(results);
  } catch (error) {
    next(error);
  }
});

router.get('/getAllBackupRegistrations', async function(req,res,next){
  try {
    const registrations = await s.backup.getAllBackupRegistrations();
    res.json(registrations);
  } catch (error) {
    next(error);
  }
});

export default router;
