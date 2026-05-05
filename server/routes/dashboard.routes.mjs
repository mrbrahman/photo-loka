import { Router } from 'express';
import * as s from '../app/services.mjs';

const router = Router();

router.get('/dashboard/stats', async function(req, res, next) {
  try {
    res.json(await s.dashboard.getStats());
  } catch (error) {
    next(error);
  }
});

export default router;
