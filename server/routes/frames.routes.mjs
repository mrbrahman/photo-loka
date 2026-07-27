import { Router } from 'express';
import { createLogger } from '../app/utils/logger.mjs';
import * as s from '../app/services.mjs';

const logger = createLogger(import.meta.url);

// *****************************************
// frame public routes (/frame)
// *****************************************
export const frameRouter = Router();

frameRouter.get('/getNext', function(req,res,next){
  const ip = req.ip.startsWith('::ffff:') ? req.ip.substring(7) : req.ip;
  try {
    let item = s.frame.getNextItem(ip);
    res.json(item);
  } catch (error) {
    next(error);
  }
});

frameRouter.get('/getPrev', function(req,res,next){
  const ip = req.ip.startsWith('::ffff:') ? req.ip.substring(7) : req.ip;
  try {
    let item = s.frame.getPrevItem(ip);
    res.json(item);
  } catch (error) {
    next(error);
  }
});

// SSE endpoint for frame notifications
export const frameSSEClients = new Map();

frameRouter.get('/events', function(req,res){
  const ip = req.ip.startsWith('::ffff:') ? req.ip.substring(7) : req.ip;
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  
  // Send initial connection message
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  
  frameSSEClients.set(ip, res);
  logger.info(`SSE client connected: ${ip}`);
  
  req.on('close', () => {
    frameSSEClients.delete(ip);
    logger.info(`SSE client disconnected: ${ip}`);
  });
});

// Listen to frame events and notify via SSE
s.frame.frameEvents.on('frame-resumed', ({frame_ip_addr}) => {
  const client = frameSSEClients.get(frame_ip_addr);
  if (client) {
    client.write(`data: ${JSON.stringify({ type: 'resume' })}\n\n`);
    logger.info(`Sent resume event to frame: ${frame_ip_addr}`);
  } else {
    logger.warn(`No SSE client found for frame: ${frame_ip_addr}`);
  }
});

s.frame.frameEvents.on('frame-paused', ({frame_ip_addr}) => {
  const client = frameSSEClients.get(frame_ip_addr);
  if (client) {
    client.write(`data: ${JSON.stringify({ type: 'pause' })}\n\n`);
    logger.info(`Sent pause event to frame: ${frame_ip_addr}`);
  } else {
    logger.warn(`No SSE client found for frame: ${frame_ip_addr}`);
  }
});

// *****************************************
// frame admin routes (/api/admin)
// *****************************************
export const adminFrameRouter = Router();

adminFrameRouter.post('/createNewFrame', async function(req,res,next){
  let entry = req.body;
  try {
    let frame_id = await s.frame.createNewFrame(entry);
    res.json({ frame_id });
  } catch (error) {
    next(error);
  }
});

adminFrameRouter.post('/loadAllFrames', async function(req,res,next){
  try {
    await s.frame.loadAllFrames();
    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});

adminFrameRouter.get('/getAllFrames', async function(req,res,next){
  try {
    res.json(await s.frame.getAllFrames());
  } catch (error) {
    next(error);
  }
});

adminFrameRouter.put('/updateFrame/:frame_id', async function(req,res,next){
  try {
    await s.frame.updateFrame(req.params.frame_id, req.body);
    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});

adminFrameRouter.delete('/deleteFrame/:frame_id', async function(req,res,next){
  try {
    await s.frame.deleteFrame(req.params.frame_id);
    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});

adminFrameRouter.post('/pauseFrame/:frame_id', async function(req,res,next){
  try {
    await s.frame.pauseFrame(req.params.frame_id, req.body.resumeAtSchedule);
    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});

adminFrameRouter.post('/resumeFrame/:frame_id', async function(req,res,next){
  try {
    await s.frame.resumeFrame(req.params.frame_id);
    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});
