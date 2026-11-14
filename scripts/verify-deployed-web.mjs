import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { assets } from './build-web.mjs';
import { VERCEL_SITE } from '../src/sites.mjs';

const base = new URL(process.argv[2] ?? VERCEL_SITE);
assert.equal(base.protocol, 'https:');
assert.ok(base.hostname.endsWith('-ykh1.vercel.app'));
const results = [];
async function check(path, status, init = {}) {
  const response = await fetch(new URL(path, base), { ...init, redirect: 'error', signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, status, path);
  results.push({ path, method: init.method ?? 'GET', status: response.status });
  return response;
}
const root = await check('/', 200);
const config = JSON.parse(await readFile(new URL('../web/vercel.json', import.meta.url), 'utf8'));
for (const header of config.headers[0].headers) assert.equal(root.headers.get(header.key), header.value, header.key);
await check('/minutes', 200);
const index = await (await check('/api/viewer/minutes', 200)).json();
assert.ok(Array.isArray(index.items) && index.items.length > 0);
for (const item of index.items) {
  const response = await check('/api/viewer/minutes/' + item.id, 200);
  const document = await response.json();
  assert.equal(document.id, item.id);
  assert.equal(document.publication_policy, 'ai-corrected-v1');
}
await check('/api/viewer/minutes/' + index.items[0].id + '.json', 200);
await check('/api/viewer/minutes/' + index.items[0].id + '.md', 200);
await check('/api/viewer/snapshot', 200);
await check('/api/viewer/schedule', 200);
await check('/api/viewer/minutes', 403, { headers: { Origin: 'https://foreign.invalid' } });
await check('/api/viewer/minutes', 405, { method: 'POST', body: '{}' });
await check('/api/sync', 401, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
await check('/api/sync', 403, { method: 'POST', headers: { Origin: 'https://foreign.invalid' }, body: '{}' });
for (const path of ['/admin.html', '/.env', '/config.local.json', '/data/access.secret', '/lib/http.mjs',
  '/deployment/runtime.mjs', '/api/viewer/node', '/api/viewer/bootstrap', '/api/viewer?route=../../data/access.secret'])
  await check(path, 404);
const hashes = [];
for (const asset of assets) {
  const response = await check('/' + asset, 200);
  const remote = Buffer.from(await response.arrayBuffer());
  const local = await readFile(new URL('../web/public/' + asset, import.meta.url));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash(remote), hash(local), asset);
  hashes.push({ asset, sha256: hash(remote) });
}
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), url: base.origin, minutes: index.items.length,
  securityHeaders: config.headers[0].headers.length, results, assets: hashes }, null, 2));
