import { mkdir, readFile, writeFile, copyFile, cp, chmod, mkdtemp, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = '24.22.1';
const name = 'node-v' + version + '-linux-x64';
const expected = '6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6';
if (process.platform !== 'linux') throw new Error('Build on Linux to preserve executable permissions');
const archive = await fetch('https://nodejs.org/dist/v' + version + '/' + name + '.tar.xz',
  { redirect: 'error', signal: AbortSignal.timeout(120000) });
if (!archive.ok) throw new Error('Official runtime download failed');
const bytes = Buffer.from(await archive.arrayBuffer());
if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Runtime checksum mismatch');
const staging = await mkdtemp(join(tmpdir(), 'jc-runtime-'));
await writeFile(join(staging, 'node.tar.xz'), bytes);
execFileSync('tar', ['-xJf', join(staging, 'node.tar.xz'), '-C', staging, name + '/bin/node', name + '/LICENSE']);
const binary = join(staging, name, 'bin/node');
if (execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim() !== 'v' + version) throw new Error('Runtime version mismatch');
const output = join(root, '.vercel/output');
const fn = join(output, 'functions/api/viewer.func');
await mkdir(join(fn, 'deployment'), { recursive: true });
await mkdir(join(output, 'static'), { recursive: true });
await copyFile(binary, join(fn, 'node'));
await chmod(join(fn, 'node'), 0o755);
await copyFile(join(staging, name, 'LICENSE'), join(fn, 'NODE-LICENSE'));
for (const file of ['handler.mjs', 'runtime.mjs']) await copyFile(join(root, 'deployment', file), join(fn, 'deployment', file));
for (const dir of ['lib', 'node_modules']) await cp(join(root, dir), join(fn, dir), { recursive: true });
await copyFile(join(root, 'package.json'), join(fn, 'package.json'));
await writeFile(join(fn, 'bootstrap'), '#!/bin/sh\ncd /var/task\nif [ -n "$AWS_LAMBDA_EXEC_WRAPPER" ]; then\n  exec "$AWS_LAMBDA_EXEC_WRAPPER" /var/task/node /var/task/deployment/runtime.mjs\nfi\nexec /var/task/node /var/task/deployment/runtime.mjs\n');
await chmod(join(fn, 'bootstrap'), 0o755);
await writeFile(join(fn, '.vc-config.json'), JSON.stringify({
  runtime: 'provided.al2023', handler: 'bootstrap', architecture: 'x86_64',
  supportsWrapper: true, maxDuration: 30, regions: ['icn1'],
}));
const assets = JSON.parse(await readFile(join(root, 'deployment/public-assets.json'), 'utf8'));
await symlink('viewer.func', join(output, 'functions/api/sync.func'));
for (const file of assets) {
  if (!/^[A-Za-z0-9_.-]+$/.test(file) || /admin|secret|config/i.test(file)) throw new Error('Unexpected public asset');
  await copyFile(join(root, 'public', file), join(output, 'static', file));
}
const source = JSON.parse(await readFile(join(root, 'vercel.json'), 'utf8'));
await writeFile(join(output, 'config.json'), JSON.stringify({ version: 3, routes: [
  { src: '/(.*)', headers: Object.fromEntries(source.headers[0].headers.map(h => [h.key, h.value])), continue: true },
  { src: '^/$', dest: '/index.html' },
  { src: '^/minutes$', dest: '/minutes.html' },
  { src: '^/api/viewer/(.*)$', dest: '/api/viewer?route=$1' },
  { handle: 'filesystem' },
  { src: '/(.*)', status: 404 },
] }));
console.log(JSON.stringify({ event: 'build.runtime_verified', node: version, sha256: expected, publicAssets: assets.length }));
