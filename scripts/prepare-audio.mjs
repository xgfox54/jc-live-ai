import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const config = JSON.parse(readFileSync(process.argv[2] ?? 'config.local.json'));
const directory = resolve(process.argv[3] ?? 'data/synthetic-speech');
const metadata = [];
for (let i = 1; i <= 8; i++) {
  const input = directory + '/ch' + i + '.wav'; const output = directory + '/ch' + i + '.pcm';
  execFileSync(config.ffmpeg, ['-nostdin', '-v', 'error', '-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', output],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const bytes = readFileSync(output);
  metadata.push({ stream: 'ch' + i, pcm_sha256: createHash('sha256').update(bytes).digest('hex'), seconds: bytes.length / 32000,
    source: 'Windows Microsoft Heami Desktop; generated text fixture; not a council recording' });
}
writeFileSync(directory + '/manifest.json', JSON.stringify(metadata, null, 2)); console.log(JSON.stringify(metadata));
