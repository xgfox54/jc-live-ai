import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Explicit provisioning only. The service never downloads models or installs packages on startup.
const root = resolve('bin/speaker-review'); const python = resolve(root, 'venv/Scripts/python.exe');
const manifest = JSON.parse(readFileSync(new URL('../licenses/speaker-review/manifest.json', import.meta.url), 'utf8'));
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const download = async (url, target, expected) => {
  if (existsSync(target) && sha(target) === expected) return;
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error('Model download failed: ' + response.status);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > 50_000_000 || createHash('sha256').update(data).digest('hex') !== expected) throw new Error('Model checksum mismatch');
  await writeFile(target, data);
};
mkdirSync(root, { recursive: true });
if (!existsSync(python)) execFileSync('uv', ['venv', '--python', '3.14', resolve(root, 'venv')], { stdio: 'inherit', windowsHide: true });
execFileSync('uv', ['pip', 'sync', '--python', python, '--require-hashes', '--no-build', resolve('worker/speaker-review-requirements.txt')], { stdio: 'inherit', windowsHide: true });
for (const model of manifest.models) {
  const target = resolve(root, model.target); mkdirSync(dirname(target), { recursive: true });
  if (model.archive_sha256) {
    const archive = resolve(root, 'segmentation.tar.bz2');
    await download(model.source, archive, model.archive_sha256);
    execFileSync('tar', ['-xjf', archive, '-C', root, model.target, model.target.replace('model.onnx', 'LICENSE')], { windowsHide: true });
  } else await download(model.source, target, model.sha256);
  if (sha(target) !== model.sha256) throw new Error('Model checksum mismatch: ' + model.name);
}
console.log(JSON.stringify({ configured: true, provider: 'cpu', threads: 2 }));
