import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createCanvas } from '@napi-rs/canvas';
import sharp from 'sharp';

const exec = promisify(execFile);
const directory = await mkdtemp(path.join(os.tmpdir(), 'eventzeka-raw-stream-'));
try {
  const canvas = createCanvas(48, 16), context = canvas.getContext('2d');
  for (const [index, color] of ['#ff0000', '#00ff00', '#0000ff'].entries()) {
    context.fillStyle = color;
    context.fillRect(index * 16, 0, 16, 16);
  }
  const raw = canvas.data();
  const png = await sharp(canvas.encodeSync('png')).ensureAlpha().raw().toBuffer();
  const jpeg = await sharp(canvas.encodeSync('jpeg', 91)).ensureAlpha().raw().toBuffer();
  assert.equal(raw.length, 48 * 16 * 4);
  assert.deepEqual(raw, png, 'native raw snapshots use RGBA channel order');
  const sample = (bytes, x) => [...bytes.subarray((8 * 48 + x) * 4, (8 * 48 + x) * 4 + 4)];
  for (const x of [8, 24, 40]) assert.ok(sample(raw, x).every((value, channel) => Math.abs(value - sample(jpeg, x)[channel]) <= 2), 'raw input preserves former JPEG channel colors');
  context.fillStyle = '#000000'; context.fillRect(0, 0, 48, 16);
  assert.equal(raw[0], 255, 'queued snapshots remain independent of later canvas draws');

  const target = path.join(directory, 'raw.mp4');
  const args = ['-hide_banner','-loglevel','error','-y','-f','rawvideo','-pixel_format','rgba','-video_size','48x16','-framerate','30','-i','pipe:0',
    '-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-map','0:v','-map','1:a','-t','0.1',
    '-vf','scale=in_range=pc:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p',
    '-c:a','aac','-b:a','128k','-ar','48000','-ac','2','-c:v','libx264','-preset','veryfast','-crf','20',
    '-maxrate','6M','-bufsize','12M','-pix_fmt','yuv420p','-r','30','-g','60','-threads','2','-movflags','+faststart',
    '-use_editlist','0','-color_range','tv','-colorspace','bt709','-color_trc','bt709','-color_primaries','bt709',target];
  const child = spawn(process.env.EVENTZEKA_FFMPEG_PATH || 'ffmpeg', args, {stdio:['pipe','ignore','pipe']});
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdin.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(errors || 'Tiny raw encode failed.')));
  });
  void completed.catch(() => {});
  child.stdin.end(Buffer.concat([raw, raw, raw]));
  await completed;
  const {stdout} = await exec('ffprobe',['-v','error','-show_entries','stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,nb_frames,sample_rate,channels,color_space,color_range','-of','json',target]);
  const metadata = JSON.parse(stdout);
  const video = metadata.streams.find(stream => stream.codec_type === 'video');
  const audio = metadata.streams.find(stream => stream.codec_type === 'audio');
  assert.deepEqual([video.codec_name, video.width, video.height, video.pix_fmt, video.avg_frame_rate, video.nb_frames], ['h264',48,16,'yuv420p','30/1','3']);
  assert.deepEqual([video.color_space,video.color_range],['bt709','tv']);
  assert.deepEqual([audio.codec_name,audio.sample_rate,audio.channels],['aac','48000',2]);
  const decoded = await exec('ffmpeg',['-v','error','-i',target,'-frames:v','1','-f','rawvideo','-pix_fmt','rgba','pipe:1'], {encoding:'buffer',maxBuffer:1_000_000});
  for (const x of [8,24,40]) assert.ok(sample(decoded.stdout,x).every((value,channel) => Math.abs(value - sample(raw,x)[channel]) <= 5),'decoded H.264 preserves raw RGB channels');
  console.log('PASS: independent RGBA snapshots, former JPEG color agreement, three-frame raw-to-H.264 stream, BT709 limited range, AAC compatibility.');
} finally {
  await rm(directory, {recursive:true,force:true});
}
