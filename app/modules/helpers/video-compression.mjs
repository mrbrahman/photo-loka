import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import {glob} from 'glob';
import {config} from '../../config.mjs';

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

export async function 

compressVideo(uuid, inputVideoPath) {
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
    
    let ffmpegCmd = ffmpeg(inputVideoPath).videoCodec(config.videoEncoder);
    
    if (isVP8) {
      ffmpegCmd.audioCodec('libvorbis')
        .addOptions(['-crf 23', '-b:v 1M', '-b:a 128k']);
    } else if (isVP9) {
      ffmpegCmd.audioCodec('libopus')
        .addOptions(['-crf 30', '-b:v 0', '-maxrate 1M', '-bufsize 2M', '-b:a 128k']);
    } else if (isHardware) {
      ffmpegCmd.audioCodec('aac')
        .addOptions(['-preset fast', '-crf 23', '-maxrate 1.5M', '-bufsize 3M', '-movflags +faststart']);
    } else {
      ffmpegCmd.audioCodec('aac')
        .addOptions(['-crf 23', '-maxrate 1.5M', '-bufsize 3M', '-movflags +faststart']);
    }
    
    let startTime = performance.now();
    ffmpegCmd.output(outputPath)
      .on('end', () => {
        console.log(`Video compression completed for ${uuid} in ${(performance.now() - startTime)/1000/60} minutes`);
        resolve(outputPath)
      })
      .on('error', (err) => reject(err))
      .run();
  });
}

export function deleteCompressedVideo(uuid) {
  const pattern = path.join(config.thumbsPath, `${uuid}_compressed_video.*`);
  const files = glob.sync(pattern);
  
  files.forEach(filePath => {
    fs.unlinkSync(filePath);
  });
}

export function getCompressedVideoPath(uuid) {
  const pattern = path.join(config.thumbsPath, `${uuid}_compressed_video.*`);
  const files = glob.sync(pattern);
  
  if (files.length > 0) {
    return files[0]; // Return first match
  }
  
  // If none exist, return path for current encoder
  const isWebM = config.videoEncoder === 'libvpx' || config.videoEncoder === 'libvpx-vp9';
  const container = isWebM ? 'webm' : 'mp4';
  return path.join(config.thumbsPath, `${uuid}_compressed_video.${container}`);
}