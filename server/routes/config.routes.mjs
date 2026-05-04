import { Router } from 'express';
import { config, getRuntimeConfig, updateRuntimeConfig } from '#runtime-config';

const router = Router();

router.get('/getConfig', function(req,res){
  res.json(getRuntimeConfig());
});

router.put('/updateConfig', function(req,res,next){
  try {
    const {key, value} = req.body;
    updateRuntimeConfig(key, value);
    res.json({ key, value: config[key] });
  } catch (error) {
    next(error);
  }
});

export default router;
