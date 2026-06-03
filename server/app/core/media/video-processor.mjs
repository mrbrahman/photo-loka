import { spawn } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs';
import {globSync} from 'node:fs';
import {config} from '#runtime-config';
import {startupConfig} from '#startup-config';
import {getFileName} from '#indexing/indexer-db';
import { createLogger } from '#utils/logger';
import { fmtTime } from '#utils/time-format';

const logger = createLogger(import.meta.url);

export async function compressVideo(uuid, filename) {
  try{ 
    if (!filename) {
      filename = await getFileName(uuid);
    } 
    let startTime = performance.now();
    logger.info(`Starting video compression for ${uuid} ${filename}`);
    await compressVideoWithFFMpeg(uuid, filename);
    logger.info(`Video compression for ${uuid} ${filename} took ${fmtTime(performance.now()-startTime)}`);
  }
  catch(err){
    logger.error(`Error compressing video for ${uuid} ${err}`);
    throw(err); 
  }
}

/*
 * Video Compression Logic:
 * 
 * VP8 (libvpx):
 *   - Container: WebM
 *   - Audio: libvorbis
 *   - Settings: 2-pass, 2.5M bitrate, 720p, bt709 color space
 * 
 * VP9 (libvpx-vp9):
 *   - Container: WebM
 *   - Audio: libopus
 *   - Settings: 2-pass, CRF 32, 2.5M bitrate, 720p, bt709 color space
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

function runFFmpeg(args, uuid, inputVideoPath) {
  return new Promise((resolve, reject) => {
    const ffmpegProcess = spawn('ffmpeg', args);

    ffmpegProcess.stderr.on('data', (data) => {
      logger.debug(`ffmpeg stderr: ${data}`);
    });

    ffmpegProcess.stdout.on('data', (data) => {
      logger.debug(`ffmpeg stdout: ${data}`);
    });

    ffmpegProcess.on('exit', (code) => {
      logger.info(`${uuid} ${inputVideoPath} ffmpeg process exited with code: ${code}`);
    });

    ffmpegProcess.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg process closed with code ${code}`));
      }
    });

    ffmpegProcess.on('error', (err) => reject(err));
  });
}

async function compressVideoWithFFMpeg(uuid, inputVideoPath) {
  const isWebM = config.videoEncoder === 'libvpx' || config.videoEncoder === 'libvpx-vp9';
  const container = isWebM ? 'webm' : 'mp4';
  
  const isVP8 = config.videoEncoder === 'libvpx';
  const isVP9 = config.videoEncoder === 'libvpx-vp9';
  const isHardware = config.videoEncoder.includes('nvenc') || config.videoEncoder.includes('qsv') || config.videoEncoder.includes('amf');

  const compressedFileName = isVP8 ? `${uuid}_2pass_vp8_compressed_video.webm`
    : isVP9 ? `${uuid}_2pass_vp9_compressed_video.webm`
    : `${uuid}_compressed_video.${container}`;
  const outputPath = path.join(
    startupConfig.thumbsDir,
    ...Array.from(uuid).slice(0,3), 
    compressedFileName
  );

  if (isVP8) {
    const passlogfile = path.join(os.tmpdir(), `ffmpeg2pass-${uuid}`);
    const commonArgs = [
      '-c:v', config.videoEncoder,
      '-b:v', '2.5M',              // Target bitrate
      // Downscale to 720p max, preserving aspect ratio. Don't upscale smaller videos
      '-vf', "scale=-2:'min(ih,720)'",
      '-threads', '4',
      '-colorspace', 'bt709',      // Standard color space for web video
      '-color_primaries', 'bt709',
      '-color_trc', 'bt709',
    ];

    // Pass 1: analysis only
    const pass1Args = ['-i', inputVideoPath, ...commonArgs,
      '-pass', '1', '-passlogfile', passlogfile, '-an', '-f', 'null',
      process.platform === 'win32' ? 'NUL' : '/dev/null'];

    logger.info(`${uuid} starting pass 1`);
    await runFFmpeg(pass1Args, uuid, inputVideoPath);

    // Pass 2: actual encode
    const pass2Args = ['-i', inputVideoPath, ...commonArgs,
      '-pass', '2', '-passlogfile', passlogfile,
      '-c:a', 'libvorbis', '-b:a', '128k', '-y', outputPath];

    logger.info(`${uuid} starting pass 2`);
    await runFFmpeg(pass2Args, uuid, inputVideoPath);

    // Cleanup passlog files
    for (const f of globSync(`${passlogfile}*`)) {
      fs.unlinkSync(f);
    }
  } else if (isVP9) {
    const passlogfile = path.join(os.tmpdir(), `ffmpeg2pass-vp9-${uuid}`);
    const commonArgs = [
      '-c:v', 'libvpx-vp9',
      '-b:v', '2.5M',              // Target bitrate cap (constrained quality mode)
      '-crf', '32',                // Quality level (15-35 range; higher -> lower quality, smaller file)
      // Downscale to 720p max, preserving aspect ratio. Don't upscale smaller videos
      '-vf', "scale=-2:'min(ih,720)'",
      '-threads', '4',
      '-row-mt', '1',              // Row-based multithreading for faster VP9 encoding
      '-pix_fmt', 'yuv420p',       // Required for broad browser playback compatibility
      '-colorspace', 'bt709',      // Standard color space for web video
      '-color_primaries', 'bt709',
      '-color_trc', 'bt709',
    ];

    // Pass 1: analysis only
    const pass1Args = ['-i', inputVideoPath, ...commonArgs,
      '-pass', '1', '-passlogfile', passlogfile, '-speed', '4', '-an', '-f', 'null',
      process.platform === 'win32' ? 'NUL' : '/dev/null'];

    logger.info(`${uuid} starting VP9 pass 1`);
    await runFFmpeg(pass1Args, uuid, inputVideoPath);

    // Pass 2: actual encode
    const pass2Args = ['-i', inputVideoPath, ...commonArgs,
      '-pass', '2', '-passlogfile', passlogfile, '-speed', '1',
      '-c:a', 'libopus', '-b:a', '128k', '-y', outputPath];

    logger.info(`${uuid} starting VP9 pass 2`);
    await runFFmpeg(pass2Args, uuid, inputVideoPath);

    // Cleanup passlog files
    for (const f of globSync(`${passlogfile}*`)) {
      fs.unlinkSync(f);
    }
  } else {
    let args = ['-i', inputVideoPath, '-c:v', config.videoEncoder];

    if (isHardware) {
      args.push('-c:a', 'aac', '-preset', 'fast', '-crf', '23', '-maxrate', '1.5M', '-bufsize', '3M', '-movflags', '+faststart');
    } else {
      args.push('-c:a', 'aac', '-crf', '23', '-maxrate', '1.5M', '-bufsize', '3M', '-movflags', '+faststart');
    }

    args.push('-y', outputPath);
    await runFFmpeg(args, uuid, inputVideoPath);
  }

  return outputPath;
}

export function deleteCompressedVideo(uuid) {
  const thumbDir = path.join(startupConfig.thumbsDir, ...Array.from(uuid).slice(0,3));
  const patterns = [
    path.join(thumbDir, `${uuid}_2pass_vp9_compressed_video.*`),
    path.join(thumbDir, `${uuid}_2pass_vp8_compressed_video.*`),
    path.join(thumbDir, `${uuid}_compressed_video.*`),
  ];
  for (const pattern of patterns) {
    for (const filePath of globSync(pattern)) {
      fs.unlinkSync(filePath);
    }
  }
}

export function streamVideo(uuid, filename){
  let filePath = resolveVideoPath(uuid, filename);
  return fs.createReadStream(filePath);
}

export async function getVideo(uuid){
  let filename = await getFileName(uuid);
  return streamVideo(uuid, filename);
}

export async function getVideoInfo(uuid, quality) {
  let filename = await getFileName(uuid);
  let filePath = resolveVideoPath(uuid, filename, quality);
  let stat = fs.statSync(filePath);
  return { filePath, fileSize: stat.size };
}

export function streamVideoRange(filePath, start, end) {
  return fs.createReadStream(filePath, { start, end });
}

function resolveVideoPath(uuid, filename, quality) {
  if (quality === 'original') return filename;

  const thumbDir = path.join(startupConfig.thumbsDir, ...Array.from(uuid).slice(0,3));

  const vp9TwoPassFile = path.join(thumbDir, uuid+'_2pass_vp9_compressed_video.webm');
  if (fs.existsSync(vp9TwoPassFile)) return vp9TwoPassFile;

  const twoPassFile = path.join(thumbDir, uuid+'_2pass_vp8_compressed_video.webm');
  if (fs.existsSync(twoPassFile)) return twoPassFile;

  const compressedFile = path.join(thumbDir, uuid+'_compressed_video.webm');
  if (fs.existsSync(compressedFile)) return compressedFile;

  return filename;
}
