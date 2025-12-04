import * as fs from 'fs';
import * as path from 'path';
import {default as sharp} from 'sharp';
import { spawn } from 'child_process';
import { createLogger } from '#utils/logger';
import { fmtTime } from '#utils/time-format';

import {config} from '#config';
import {overlays} from '#overlays/all-overlays.mjs';
import * as db from '#indexing/indexer-db';

const logger = createLogger(import.meta.url);

const sizes = [
  // below are thumbnails with same aspect ratio as original image
  {height: 20,  fit: 'inside', suffix: 'fit', playIcon: 'play-button-5.png'},  // small thubnail to give the feel of "loading"
  {height: 100, fit: 'inside', suffix: 'fit', playIcon: 'play-button-40.png'},
  {height: 250, fit: 'inside', suffix: 'fit', playIcon: 'play-button-100.png'},
  {height: 500, fit: 'inside', suffix: 'fit', playIcon: 'play-button-200.png'},  // TODO: do we really need this?

  // below is a square thumbnail
  {width: 50,  height: 50,  fit: 'cover', suffix: 'center', playIcon: 'play-button-20.png'}
];

let thumbsDir = config.thumbsDir;

// Note Samsung phones have issue, which needs {failOnError: true}
// when reading the image / buffer with sharp
// https://github.com/lovell/sharp/issues/1578

export async function createImageThumbnails(uuid, buf, playImageOverlay){
  // We don't want all thumbnails in one directory. Hence, create
  // sub-dirs based on the first 3 chars of the uuid.
  // If we have the uuid in the front end, we can directly go to the
  // location of the thumbnails.
  // Idea found at: https://stackoverflow.com/a/2994603

  let start = performance.now();
  let imageThumbsDir = path.join(
    thumbsDir,
    ...Array.from(uuid).slice(0,3)    // 3 levels deep
  )

  if(!fs.existsSync(imageThumbsDir)){
    fs.mkdirSync(imageThumbsDir, {recursive: true})
  }

  let thumbnailPromises = sizes.map(s=>{
    // sharp returns itself until a 'write' (e.g. toFile) operation is invoked,
    // at which time a promise is returned
    let sharpInstance = sharp(buf, { failOnError: false })
      .rotate()  // rotate based on exif Orientation
      .resize(s)
    ;
    if (playImageOverlay){
      sharpInstance
        .composite([{input: overlays[s.playIcon]}]) // default center overlay
    }

    // return a promise
    return sharpInstance
      .toFile(path.join(
        imageThumbsDir,
        `${uuid}_${s.height}_${s.suffix}.jpg`
      ))
    ;
  });
  
  await Promise.all(thumbnailPromises);
  logger.info(`thumbs: For ${uuid} generated ${sizes.length} thumbnails in ${fmtTime(performance.now()-start)}`);

  // TODO: extract and return image hash? (to help identify dups)
}

export async function generateVideoThumbnail(uuid, videoFilename){
  return new Promise((resolve,reject)=>{
    // use the same thumbnails dir to store vide thumbnail (screenshot) as well.
    // in case of videos, we additionally store the full video screenshot,
    // and extract image thumbnails from that video screenshot
    let videoThumbsDir = path.join(
      thumbsDir,
      ...Array.from(uuid).slice(0,3)    // 3 levels deep
    );
    if (!fs.existsSync(videoThumbsDir)) {
      fs.mkdirSync(videoThumbsDir, { recursive: true });
    }

    const outputPath = path.join(videoThumbsDir, `${uuid}.jpg`);
    const args = ['-i', videoFilename, '-vframes', '1', '-y', outputPath];
    
    const ffmpegProcess = spawn('ffmpeg', args);
    
    ffmpegProcess.on('close', (code) => {
      if (code === 0) {
        resolve(outputPath);
      } else {
        reject(new Error(`ffmpeg process exited with code ${code}`));
      }
    });
    
    ffmpegProcess.on('error', (error) => {
      logger.error(`FFMpeg error for ${videoFilename}: ${error}`);
      reject(error);
    });
  });
}

export function deleteImageThumbnails(uuid){
  let dir = path.join(
    thumbsDir,
    ...Array.from(uuid).slice(0,3)
  );

  if(fs.existsSync(dir)){
    fs.readdirSync(dir)
      .filter(f=>f.startsWith(uuid))
      .forEach(f=>fs.unlinkSync(path.join(dir,f)))
    ;
  }
}

export function resizeImage(filename, width, height){
  const readStream = fs.createReadStream(filename);
  let transform = sharp({failOnError: false})
    .rotate()
    .resize({
      width: width, 
      height: height,
      fit: "inside",
      withoutEnlargement: true
    });
  
  return readStream.pipe(transform);
}

export async function refreshThumbs(uuid){
  logger.info(`Starting refreshThumbs for uuid : ${uuid}`);


  let meta = await db.retriveMetadata(uuid),
    filename = meta.filename, playImageOverlay = false;
  let imageFileName = filename;

  if(!fs.existsSync(filename)){
    logger.error(`${filename} not found`)
    return;
  }
  
  if (meta.mediatype === 'video'){
    logger.info(`refreshThumbs - Generating video thumbnail: ${uuid} ${filename}`);
    imageFileName = await generateVideoThumbnail(uuid, filename);
    playImageOverlay=true;
  }

  let buf = fs.readFileSync(imageFileName);
  await createImageThumbnails(uuid, buf, playImageOverlay);
}

export async function getImage(uuid, width, height){
  let filename = await db.getFileName(uuid);
  return resizeImage(filename, width, height);
}
