import * as fs from 'fs';
import * as path from 'path';
import {default as sharp} from 'sharp';
import {config} from '#config';
import { createLogger } from '#utils/logger';
import { fmtTime } from '#utils/time-format';

const logger = createLogger(import.meta.url);

let facesDir = config.facesDir;

export async function extractFaceRegions(uuid, buf, xmpregion) {
  let start = performance.now();
  
  let faceExtractPromises=[], parsedFaces=[];
  let faces = xmpregion.RegionList.filter(d => d.Type == 'Face');
  
  for (let face of faces) {

    // ignore un-named faces
    if(!face.Name){
      logger.warn(`${uuid} Skipping face extraction. No face tagged at x: ${face.Area.X} y: ${face.Area.Y} w: ${face.Area.W} h: ${face.Area.H}`);
      continue;
    }

    let faceDir = path.join(facesDir, face.Name);
    if (!fs.existsSync(faceDir)) {
      fs.mkdirSync(faceDir, { recursive: true });
    }

    let { W, H } = xmpregion.AppliedToDimensions;

    // Note: xmp stores X and Y as center of the area
    let [left, width] = [face.Area.X - face.Area.W / 2, face.Area.W].map(x => Math.floor(x * W));
    let [top, height] = [face.Area.Y - face.Area.H / 2, face.Area.H].map(x => Math.floor(x * H));
    logger.debug(`${uuid} extracting ${left} ${top} ${width} ${height} for ${face.Name}`);

    // check if dimensions are valid
    if(left+width > W || top+height > H){
      logger.warn(`${uuid} Skipping face extraction. Bad extract area. Pic dimensions w: ${W} h: ${H}`);
      continue;
    }

    // add a promise
    let facePromise = sharp(buf, { failOnError: false })
      .withMetadata() // keep metadata to help with rotation after extract
      .extract({
        left: left,
        top: top,
        width: width,
        height: height
      })
      .toBuffer()
      .then((faceBuf)=>{
        sharp(faceBuf)
          // rotate the image, and lose the metadata
          .rotate()
          // TODO: same face appearing multiple times in the image? for e.g a photo in a photo?
          .toFile(path.join(faceDir, `${uuid}.jpg`)) 
      })
    ;
    
    faceExtractPromises.push(facePromise);
    parsedFaces.push(face)
  }

  await Promise.all(faceExtractPromises);
  logger.info(`faces: For ${uuid} generated ${faceExtractPromises.length} in ${fmtTime(performance.now()-start)}`);

  return parsedFaces;
}

export function deleteFaceThumbnails(uuid){
  let dir = path.join(
    facesDir,
    ...Array.from(uuid).slice(0,3)
  );

  if(fs.existsSync(dir)){
    fs.readdirSync(dir)
      .filter(f=>f.startsWith(uuid))
      .forEach(f=>fs.unlinkSync(path.join(dir,f)))
    ;
  }
}