import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import {glob} from 'glob';
import {config} from '#config';
import {getFileName} from '#indexing/indexer-db';

export async function compressVideo(uuid, filename) {
  try{ 
    if (!filename) {
      filename = await getFileName(uuid);
    } 
    let startTime = performance.now();
    console.log(`Starting video compression for ${uuid} ${filename}`);
    await compressVideoWithFFMpeg(uuid, filename);
    console.log(`Video compression for ${uuid} ${filename} took ${(performance.now()-startTime)/1000/60} minutes`);
  }
  catch(err){
    console.log(`Error compressing video for ${uuid} ${err}`);
    throw(err); 
  }
}

/*
 * Video Compression Logic:
 * 
 * VP8 (libvpx):
 *   - Container: WebM
 *   - Audio: libvorbis
 *   - Settings: CRF 23, 1M bitrate (fast encoding, good compression)
 * 
 * VP9 (libvpx-vp9):
 *   - Container: WebM
 *   - Audio: libopus
 *   - Settings: CRF 30, constrained bitrate (slow encoding, best compression)
 * 
 * Hardware H.264 (h264_nvenc/h264_qsv/h264_amf):
 *   - Container: MP4
 *   - Audio: AAC
 *   - Settings: fast preset, CRF 23, faststart for streaming
 * 
 * Software H.264 (libx264):
 *   - Container: MP4
 *   - Audio: AAC
 *   - Settings: CRF 23, streaming optimized
 */

async function compressVideoWithFFMpeg(uuid, inputVideoPath) {
  const isWebM = config.videoEncoder === 'libvpx' || config.videoEncoder === 'libvpx-vp9';
  const container = isWebM ? 'webm' : 'mp4';
  
  const outputPath = path.join(
    config.thumbsDir,
    ...Array.from(uuid).slice(0,3), 
    `${uuid}_compressed_video.${container}`
  );
  
  return new Promise((resolve, reject) => {
    const isVP8 = config.videoEncoder === 'libvpx';
    const isVP9 = config.videoEncoder === 'libvpx-vp9';
    const isHardware = config.videoEncoder.includes('nvenc') || config.videoEncoder.includes('qsv') || config.videoEncoder.includes('amf');
    
    let args = ['-i', inputVideoPath, '-c:v', config.videoEncoder];
    
    if (isVP8) {
      args.push('-c:a', 'libvorbis', '-crf', '23', '-b:v', '1M', '-b:a', '128k');
    } else if (isVP9) {
      args.push('-c:a', 'libopus', '-crf', '30', '-b:v', '0', '-maxrate', '1M', '-bufsize', '2M', '-b:a', '128k');
    } else if (isHardware) {
      args.push('-c:a', 'aac', '-preset', 'fast', '-crf', '23', '-maxrate', '1.5M', '-bufsize', '3M', '-movflags', '+faststart');
    } else {
      args.push('-c:a', 'aac', '-crf', '23', '-maxrate', '1.5M', '-bufsize', '3M', '-movflags', '+faststart');
    }
    
    args.push('-y', outputPath);
    
    const ffmpegProcess = spawn('ffmpeg', args);

    ffmpegProcess.stderr.on('data', (data) => {
      // console.log(`ffmpeg stderr: ${data}`);
    });

    ffmpegProcess.stdout.on('data', (data) => {
      // console.log(`ffmpeg stdout: ${data}`);
    });

    ffmpegProcess.on('exit', (code) => {
      console.log(`ffmpeg process exited with code ${code}`);
    });
    
    ffmpegProcess.on('close', (code) => {
      if (code === 0) {
        resolve(outputPath);
      } else {
        reject(new Error(`ffmpeg process closed with code ${code}`));
      }
    });
    
    ffmpegProcess.on('error', (err) => reject(err));
  });
}

// TODO: fix path
export function deleteCompressedVideo(uuid) {
  const pattern = path.join(config.thumbsDir, `${uuid}_compressed_video.*`);
  const files = glob.sync(pattern);
  
  files.forEach(filePath => {
    fs.unlinkSync(filePath);
  });
}

// TODO: Fix path
export function getCompressedVideoPath(uuid) {
  const pattern = path.join(config.thumbsDir, `${uuid}_compressed_video.*`);
  const files = glob.sync(pattern);
  
  if (files.length > 0) {
    return files[0]; // Return first match
  }
  
  // If none exist, return path for current encoder
  const isWebM = config.videoEncoder === 'libvpx' || config.videoEncoder === 'libvpx-vp9';
  const container = isWebM ? 'webm' : 'mp4';
  return path.join(config.thumbsDir, `${uuid}_compressed_video.${container}`);
}

export function streamVideo(uuid, filename){
  let readStream;

  let webmFile = path.join(
    config.thumbsDir,
    ...Array.from(uuid).slice(0,3),
    uuid+'_compressed_video.webm'
  );

  if(fs.existsSync(webmFile)){
    readStream = fs.createReadStream(webmFile);
  } else {
    readStream = fs.createReadStream(filename);
  }

  return readStream;
}

export async function getVideo(uuid){
  let filename = await getFileName(uuid);
  return streamVideo(uuid, filename);
}
