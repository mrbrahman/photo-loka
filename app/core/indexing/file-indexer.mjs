import * as fs from 'fs';
import {v4 as uuidv4} from 'uuid';

import * as exifManager from '../media/exif-manager.mjs';
import * as thumbnailManager from '../media/thumbnail-manager.mjs';
import * as videoProcessor from '../media/video-processor.mjs';
import * as faceExtractor from '../media/face-extractor.mjs';
import * as fileOps from './file-organizer.mjs';

import * as db from './indexer-db.mjs';
import { enqueue as enqueueReverseGeoEncoding } from '../geo/geo-encoder.mjs';

export async function indexFile(collection, sourceFileName, uuid, inPlace){
  // indexing is a series of steps, where the latter steps
  // are dependent on former steps
  console.log(`Indexing ${sourceFileName}`);
  let fileStart = performance.now();
  
  // Step 1: Read metadata from file
  // unfortunately cannot pass buffer here
  try{
    var p = await exifManager.getMetadata(sourceFileName);
  } catch(error){
    throw `ERROR during getMetadata for file: ${sourceFileName}: ${error}`;
  }

  // TODO: split this into i) get album name and ii) move the file to collection at the end
  // Step 2: Use the metadata to physically move the file into collection. Determine album
  try{
    var f = await fileOps.placeFileInCollection(collection, sourceFileName, p.file_date, inPlace);
  } catch(error){
    throw `ERROR during placeFileInCollection for file: ${sourceFileName}: ${error}`;
  }
  
  // Step 3: Generate uuid, and make metadata current
  try{
    p = {...p, ...f, uuid: uuid ? uuid : uuidv4(), collection_id: collection.collection_id}
  } catch(error){
    throw `ERROR during Generate uuid for file: ${sourceFileName}: ${error}`;
  }
  
  // Step 4: Video thumbnail extraction
  if(p.mediatype == "video" || p.mediatype == "image"){

    let imageFileName = p.filename, playImageOverlay=false;
    if(p.mediatype == "video"){
      try{
        // extract video thumbnail (screenshot) and use that image to extract image thumbs
        imageFileName = await thumbnailManager.generateVideoThumbnail(p.uuid, p.filename);
        playImageOverlay=true;
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
      await thumbnailManager.createImageThumbnails(p.uuid, buf, playImageOverlay);
    } catch(error){
      throw `ERROR during createImageThumbnails for file: ${sourceFileName}: ${error}`;
    }

    // Step 5: video compression for streaming
    try{
      if(p.mediatype == "video"){
        // perform video compression to help with streaming
        await videoProcessor.compressVideo(p.uuid, p.filename);
      }
    } catch(error){
      throw `ERROR during compressVideo for file: ${sourceFileName}: ${error}`;
    }

    // Step 6: face region extraction (if present)
    // TODO: is this really needed? revisit during face recognition implementation
    if (p.xmpregion
      && p.xmpregion.RegionList.filter(d => d.Type == 'Face').length > 0
      && p.xmpregion.AppliedToDimensions.Unit == 'pixel') // TODO: don't know what to do with others just yet
    {
      let { W, H } = p.xmpregion.AppliedToDimensions;
      if (W != p.ImageWidth || H != p.ImageHeight) {
        // TODO: what should we do when RegionAppliedToDimensions don't match image height and width?
        console.warn(`${imageFileName} has different region dimensions! Actual ${p.ImageWidth}x${p.ImageWidth} vs ${W}x${H}`);
      }
      try{
        p.parsedFaces = await faceExtractor.extractFaceRegions(p.uuid, buf, p.xmpregion);
      } catch(error){
        throw `ERROR during extractFaceRegions for file: ${sourceFileName}: ${error}`;
      }
    }
  }

  // grab the country code before sending to DB (as DB converts it to JSON string)
  let countryCode = p.geolocation_api_json?.GeolocationCountryCode
  
  // Step 8: Make an entry in db
  await db.insertMetadataRow(p);

  // -------------------------
  // Enrichments
  // -------------------------
  // Step 7: Queue reverse geo encoding if GPS coordinates are available and location is in US
  if (p.gps_lat && p.gps_long && countryCode === 'US') {
    enqueueReverseGeoEncoding(p.uuid, p.gps_lat, p.gps_long);
  }

  console.log(`Indexing of ${sourceFileName} finished in ${performance.now()-fileStart} ms`);
}