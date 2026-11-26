import { spawn } from 'node:child_process';
import { resolveYouTube } from './youtube.mjs';

// Sound check for a broadcast left on air after its collection was closed (BroadcastMonitor.close). On 2026-11-24 the
// 교육위원회 recess audio peaked at -66 dB with a -80 dB mean, and its speech before the recess averaged -26 dB. A 20 ms frame
// at SOUND_DBFS or louder counts as sound; a sample is sound when 5% of its frames are (one cough or click is not).
export const SOUND_DBFS = -45;
export const WATCH_MS = 180_000;
export function soundLevel(pcm) {
  let frames = 0; let loud = 0; let loudest = -Infinity;
  for (let offset = 0; offset + 640 <= pcm.length; offset += 640) {
    let sum = 0; for (let i = offset; i < offset + 640; i += 2) { const value = pcm.readInt16LE(i); sum += value * value; }
    const dbfs = 10 * Math.log10(sum / 320 / 32768 ** 2 + 1e-12);
    frames++; if (dbfs >= SOUND_DBFS) loud++; loudest = Math.max(loudest, dbfs);
  }
  return { frames, loudest_dbfs: frames ? Math.round(loudest * 10) / 10 : null, sound_share: frames ? loud / frames : 0, sound: frames > 0 && loud / frames >= 0.05 };
}
// Reads seconds of audio at the live edge of the broadcast the probe resolved (YouTube or the council's HLS playlist).
export async function sampleSound(config, source, signal, seconds = 15) {
  const url = source.resolved_kind === 'hls' && source.media_url ? source.media_url
    : await resolveYouTube(config, { ...source, page_url: 'https://www.youtube.com/watch?v=' + source.video_id }, signal);
  return new Promise((resolve, reject) => {
    const child = spawn(config.ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'https,tls,tcp',
      '-rw_timeout', '15000000', '-i', url, '-t', String(seconds), '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'],
    { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'], signal });
    const chunks = []; let size = 0; const limit = 32_000 * seconds;
    const timer = setTimeout(() => child.kill(), (seconds + 45) * 1000);
    child.stdout.on('data', part => { if (size < limit) { chunks.push(part); size += part.length; } });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', () => { clearTimeout(timer); const pcm = Buffer.concat(chunks).subarray(0, limit);
      pcm.length >= 32_000 ? resolve(soundLevel(pcm)) : reject(new Error('Too little audio to check')); });
  });
}
