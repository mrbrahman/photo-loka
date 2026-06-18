import * as fs from 'fs';
import * as path from 'path';
import {v4 as uuidv4} from 'uuid';
import { createLogger } from '#utils/logger';
import { fmtTime } from '#utils/time-format';

import * as exifManager from '#media/exif-manager';
import * as thumbnailManager from '#media/thumbnail-manager';
import * as videoProcessor from '#media/video-processor';
import * as faceExtractor from '#media/face-extractor';
import * as fileOps from './file-organizer.mjs';
import { addToIndexQueue } from './queue-manager.mjs';

import * as db from './indexer-db.mjs';
import { enqueue as enqueueReverseGeoEncoding } from '#geo/geo-encoder';
import { processFaceRecognition } from '#ml/ml-manager';
import {config} from '#runtime-config';
import {startupConfig} from '#startup-config';

const logger = createLogger(import.meta.url);

export async function indexFile(collection, sourceFileName, uuid, inPlace){
  // indexing is a series of steps, where the latter steps
  // are dependent on former steps
  logger.info(`Indexing ${sourceFileName}`);
  let fileStart = performance.now();

  // Step 1: Read metadata from file
  // unfortunately cannot pass buffer here
  try{
    var p = await exifManager.getMetadata(sourceFileName);
  } catch(error){
    throw `ERROR during getMetadata for file: ${sourceFileName}: ${error}`;
  }

  // Step 1b: Fall back for captured_at if EXIF didn't yield a valid one.
  //  - intake: file isn't placed yet; we need *some* value to drive folder
  //    placement. Fall back to mtime (current behavior pre-timeline-view).
  //  - inPlace: leave captured_at null - the file has no real capture time.
  //    album_date will still be derived from the folder via the pattern
  //    engine inside placeFileInCollection, so the timeline grouping
  //    works fine (captured_at null -> no time stamp shown, item sorted to
  //    the end of its day).
  if (!p.captured_at && !inPlace) {
    p.captured_at = p.file_modified_at;
    logger.info(`No EXIF date for ${sourceFileName}; falling back to file_modified_at: ${p.captured_at}`);
  }

  // Step 2: Place the file (intake = move to its computed folder; inPlace =
  // just inspect the folder and split into album_date/album_name).
  try{
    var f = await fileOps.placeFileInCollection(collection, sourceFileName, p.captured_at, inPlace);
  } catch(error){
    throw `ERROR during placeFileInCollection for file: ${sourceFileName}: ${error}`;
  }

  // Step 3: Generate uuid, and make metadata current. f provides
  // {album_date, album_name, filename}; merging onto p gives the full row.
  try{
    p = {...p, ...f, uuid: uuid ? uuid : uuidv4(), collection_id: collection.collection_id}
  } catch(error){
    throw `ERROR during Generate uuid for file: ${sourceFileName}: ${error}`;
  }

  // Step 4: Video thumbnail extraction
  if(p.mediatype == "video" || p.mediatype == "image"){

    let imageFileName = p.filename;
    if(p.mediatype == "video"){
      try{
        // extract video thumbnail (screenshot) and use that image to extract image thumbs
        imageFileName = await thumbnailManager.generateVideoThumbnail(p.uuid, p.filename);
      } catch(error){
        throw `ERROR during video processing for file: ${p.filename}: ${error}`;
      }
    }

    // read image once
    let buf;
    try{
      buf = fs.readFileSync(imageFileName);
    } catch(error){
      throw `ERROR during readFileSync before thumbnail ${sourceFileName} ${error}`
    }

    // thumbnails generation
    try{
      await thumbnailManager.createImageThumbnails(p.uuid, buf);
    } catch(error){
      throw `ERROR during createImageThumbnails for file: ${sourceFileName}: ${error}`;
    }

    // Step 5: video compression to help with streaming on browsers
    try{
      if(p.mediatype == "video"){
        // Check for pre-compressed webm file
        const baseName = path.basename(sourceFileName, path.extname(sourceFileName));
        const sourceDir = path.dirname(sourceFileName);
        const preCompressedWebm = path.join(sourceDir, `${baseName}_compressed_video.webm`);

        if(fs.existsSync(preCompressedWebm)){
          // Move pre-compressed webm to thumbnail directory
          const thumbsDir = path.join(
            startupConfig.thumbsDir,
            ...Array.from(p.uuid).slice(0,3),
            `${p.uuid}_compressed_video.webm`
          );
          await fileOps.moveItem(null, preCompressedWebm, thumbsDir, true);
          logger.info(`Moved pre-compressed webm: ${preCompressedWebm}`);
        } else {
          if(collection.compress_videos){
            // perform video compression to help with streaming
            // add to the 'low' priority indexing queue
            addToIndexQueue(videoProcessor.compressVideo, [p.uuid, p.filename], 'low');
          } else {
            logger.info(`Skipping video compression (not enabled for collection) for file: ${p.uuid} ${p.filename}`);
          }
        }
      }
    } catch(error){
      throw `ERROR during video compression for file: ${sourceFileName}: ${error}`;
    }

    // Step 6: face region extraction - skipped, now handled by ML face recognition (Step 9)
  }

  // grab the country code before sending to DB (as DB converts it to JSON string)
  let countryCode = p.exiftool_geo_json?.GeolocationCountryCode

  // save xmpregion before DB insert mutates it to a JSON string
  let xmpregionRaw = p.xmpregion;

  // Step 8: Make an entry in db
  await db.insertMetadataRow(p);

  // -------------------------
  // Enrichments
  // -------------------------
  // Step 7: Queue reverse geo encoding if GPS coordinates are available and location is in US
  if (p.gps_lat && p.gps_lng && countryCode === 'US') {
    enqueueReverseGeoEncoding(p.uuid, p.gps_lat, p.gps_lng);
  }

  // Step 9: Queue face recognition for images
  if (p.mediatype === 'image') {
    if (config.performFaceRecognition) {
      addToIndexQueue(processFaceRecognition, [p.uuid, p.filename, p.orientation, xmpregionRaw], 'normal');
    } else {
      logger.info(`Skipping face recognition as per config for file: ${p.uuid} ${p.filename}`);
    }
  }

  logger.info(`Indexing of ${sourceFileName} finished in ${fmtTime(performance.now()-fileStart)}`);
}
