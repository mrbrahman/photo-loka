import { Router } from 'express';
import * as s from '../app/services.mjs';

// *****************************************
// Public collection routes (/api)
// *****************************************
const router = Router();

router.get('/getAllCollections', async function(req, res){
  res.json( await s.collections.getAllCollections() );
});

export default router;

// *****************************************
// Admin collection routes (/api/admin)
// *****************************************
export const adminCollectionsRouter = Router();

adminCollectionsRouter.post('/createNewCollection', async function(req, res, next){
  let c = req.body;
  try {
    let id = await s.collections.createNewCollection(c);
    res.json(id);
  } catch (error){
    next(error);
  }
});

adminCollectionsRouter.put('/updateCollection/:id', async function(req, res, next){
  let id = parseInt(req.params.id);
  let c = req.body;
  try {
    await s.collections.updateCollection(id, c);
    res.json({ success: true });
  } catch (error){
    next(error);
  }
});

adminCollectionsRouter.get('/listSubDirs', async function(req, res, next){
  let dirPath = req.query.path;
  try {
    if (!dirPath) {
      return res.status(400).json({ error: { message: 'path query parameter is required' } });
    }
    if (!s.collections.isValidDir(dirPath)) {
      return res.status(400).json({ error: { message: 'Path does not exist or is not a directory' } });
    }
    let dirs = s.collections.listSubDirs(dirPath);
    res.json(dirs);
  } catch (error) {
    next(error);
  }
});

adminCollectionsRouter.post('/validateFolderPattern', async function(req, res){
  let { pattern } = req.body;
  if (!pattern) {
    return res.status(400).json({ valid: false, error: 'Pattern is required' });
  }
  res.json(s.collections.validateFolderPattern(pattern));
});
