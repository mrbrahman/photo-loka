import * as path from 'path';
import * as fs from 'fs';
import { Router } from 'express';
import { startupConfig } from '#startup-config';
import { authenticateMediaAccess } from '../middleware/authn-middleware.mjs';
import * as s from '../app/services.mjs';

const router = Router();

router.get('/getThumbnail', authenticateMediaAccess, function(req,res){
  let uuid = req.query.uuid, height = +req.query.height;

  // TODO: get the list of sizes from indexer / thumbnail generator
  let thumbHeight = [100, 250, 500].filter(x=> x >= height)[0] || 500;

  // console.log(`inputs: uuid ${uuid} height ${height}`)
  let fileName = path.join(startupConfig.thumbsDir, ...Array.from(uuid).slice(0,3), `${uuid}_${thumbHeight}_fit.jpg`);
  // console.log(`getting thumbnail: ${fileName}`)
  res.sendFile(fileName);
});

router.get('/getImage', authenticateMediaAccess, async function(req,res){
  let uuid = req.query.uuid, height = +req.query.height, width = +req.query.width;
  
  res.type('image/jpg');
  // res.set({
  //   "Content-Disposition": `inline;filename="${filename.split(/\//).pop()}"`
  // });

  // (await s.thumbnails.getImage(uuid, width, height)).pipe(res);
  (await s.thumbnails.getImage(uuid, 1920, 1080)).pipe(res);
});

router.get('/getVideo', authenticateMediaAccess, async function(req, res, next){
  let uuid = req.query.uuid;
  let quality = req.query.quality || 'compressed';

  try {
    const { filePath, fileSize } = await s.videos.getVideoInfo(uuid, quality);
    const range = req.headers.range;
    const contentType = filePath.endsWith('.webm') ? 'video/webm' : 'video/mp4';

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.status(206);
      res.set({
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
      });

      const stream = s.videos.streamVideoRange(filePath, start, end);
      stream.pipe(res);
    } else {
      res.set({
        'Content-Length': fileSize,
        'Content-Type': contentType,
      });
      const stream = s.videos.streamVideoRange(filePath, 0, fileSize - 1);
      stream.pipe(res);
    }
  } catch (error) {
    next(error);
  }
});

router.get('/getFaceThumbnail', authenticateMediaAccess, async function(req,res,next){
  try {
    let {uuid, cluster_id} = req.query;
    let filePath = path.join(startupConfig.facesDir, cluster_id, `${uuid}.jpg`);
    if (!fs.existsSync(filePath)) return res.status(404).end();
    res.sendFile(path.resolve(filePath));
  } catch (error) {
    next(error);
  }
});

export default router;
