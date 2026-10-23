import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { handleEvent } from '../web/deployment/handler.mjs';
import { assets } from '../scripts/build-web.mjs';

const secret = 'c'.repeat(64);
const host = 'fixture.vercel.app';
const event = (path, method = 'GET', body, headers = {}) => ({
  Action: 'Invoke', body: JSON.stringify({ host, path, method, headers,
    ...(body == null ? {} : { body: Buffer.from(body).toString('base64'), encoding: 'base64' }) }),
});
const decode = result => JSON.parse(Buffer.from(result.body, 'base64').toString('utf8'));

test('custom runtime retains publisher authentication, origin, schema, compression and replay checks', async () => {
  const now = Date.now(); const rows = new Map(); let writes = 0;
  const storage = {
    async read(path) { return rows.get(path); },
    async write(path, value) { writes++; rows.set(path, { value, etag: '1' }); },
  };
  const options = { storage, secret, now: () => now };
  const data = { kind: 'snapshot', published_ms: now, snapshot: { event_id: 0, streams: [], segments: [], states: [], gaps: [], before: {} }, minutes_index: [] };
  const body = Buffer.from(JSON.stringify(data));
  const headers = { authorization: 'Bearer ' + secret, 'content-type': 'application/json' };
  const send = (bytes, extra = {}) => handleEvent(event('/api/sync', 'POST', bytes, { ...headers, ...extra }), options);
  assert.equal((await send(body, { authorization: 'wrong' })).statusCode, 401);
  assert.equal((await send(body, { origin: 'https://foreign.test' })).statusCode, 403);
  assert.equal((await send(Buffer.from('invalid'))).statusCode, 400);
  assert.equal((await send(Buffer.alloc(3500001))).statusCode, 413);
  assert.equal(writes, 0);
  assert.equal((await send(gzipSync(body), { 'content-encoding': 'gzip' })).statusCode, 200);
  assert.equal((await send(body)).statusCode, 200);
  assert.equal(writes, 1);
  assert.equal((await send(Buffer.from(JSON.stringify({ ...data, published_ms: now - 1 })))).statusCode, 409);
  const result = await handleEvent(event('/api/viewer?route=minutes'), options);
  assert.equal(result.statusCode, 200); assert.deepEqual(decode(result), { items: [] });
  assert.equal((await handleEvent(event('/api/viewer/minutes', 'POST'), options)).statusCode, 405);
  assert.equal((await handleEvent(event('/api/viewer/minutes', 'GET', null, { origin: 'https://foreign.test' }), options)).statusCode, 403);
  assert.equal((await handleEvent(event('/api/admin'), options)).statusCode, 404);
});

test('proxy adapter preserves binary gzip response and rejects malformed transport paths', async () => {
  const doc = { id: 'a'.repeat(64), title: '회의', status: 'draft', updated_ms: 1, session_count: 1, paragraph_count: 0, segment_count: 0 };
  const value = { kind: 'snapshot', published_ms: Date.now(), snapshot: { event_id: 0, streams: [], segments: [], states: [], gaps: [], before: {} },
    minutes_index: Array.from({ length: 500 }, () => ({ ...doc, title: '회의'.repeat(100) })) };
  const storage = { async read() { return { value }; } };
  const result = await handleEvent(event('/api/viewer/minutes', 'GET', null, { 'accept-encoding': 'gzip' }), { storage });
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['content-encoding'], 'gzip');
  assert.equal(JSON.parse(gunzipSync(Buffer.from(result.body, 'base64'))).items.length, 500);
  for (const path of ['//foreign.test/api/sync', '/api/\\sync', 'https://foreign.test'])
    await assert.rejects(handleEvent(event(path)), /Invalid proxy/);
});

test('custom entrypoint rejects an old Node version before handling requests', () => {
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import {handleEvent} from './web/deployment/handler.mjs';
    Object.defineProperty(process.versions, 'node', {value:'24.21.0'});
    try { await handleEvent({body:'{}'}); process.exitCode=1; }
    catch(error) { if(!error.message.includes('requires Node.js')) throw error; console.log('blocked'); }
  `], { cwd: new URL('../', import.meta.url), encoding: 'utf8' });
  assert.match(output, /blocked/);
});

test('custom deployment public manifest matches the existing public allowlist', () => {
  const manifest = JSON.parse(readFileSync(new URL('../web/deployment/public-assets.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest, assets);
  assert.ok(!manifest.some(name => /admin|secret|config/.test(name)));
});

test('platform OIDC token stays isolated between requests and never reaches the response', async () => {
  const current = () => globalThis[Symbol.for('@vercel/request-context')].get()?.headers?.['x-vercel-oidc-token'];
  const invoke = token => handleEvent(event('/api/viewer/minutes', 'GET', null,
    token ? { 'x-vercel-oidc-token': token } : {}), { storage: { async read() {
      await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(current(), token);
      return null;
    } } });
  const results = await Promise.all([invoke('fixture-first'), invoke('fixture-second'), invoke(undefined)]);
  for (const result of results) {
    assert.equal(result.statusCode, 503);
    assert.doesNotMatch(JSON.stringify(result.headers), /fixture-|oidc/i);
    assert.doesNotMatch(Buffer.from(result.body, 'base64').toString(), /fixture-|oidc/i);
  }
  assert.equal(current(), undefined);
});
