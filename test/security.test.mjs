import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { Security } from '../src/security.mjs';
import { proxyBase, sealCredential, openCredential } from '../src/ai-proxy.mjs';
import { mediaSignature } from '../src/import-audio.mjs';
import { Store } from '../src/store.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { createService } from '../src/server.mjs';

const admin = 'a'.repeat(64); const viewer = 'b'.repeat(64);
const request = token => ({ headers: { host: '127.0.0.1:4320', authorization: 'Bearer ' + token } });
test('ten failed credentials lock authentication for ten minutes, including the correct key', () => {
  let now = 0; const security = new Security({ adminToken: admin, viewerToken: viewer }, () => now);
  for (let i = 0; i < 10; i++) assert.throws(() => security.authorize(request('c'.repeat(64)), true), error => error.status === 401);
  assert.throws(() => security.authorize(request(admin), true), error => error.status === 429);
  now = 600_001; assert.equal(security.authorize(request(admin), true), true);
  assert.throws(() => security.authorize({ headers: { host: 'evil.test' } }, true), error => error.status === 403);
});
test('proxy rejects link-local and metadata destinations', () => {
  for (const value of ['https://169.254.169.254/v1', 'https://[fe80::1]/v1', 'https://[::ffff:a9fe:a9fe]/v1', 'https://0.0.0.0/v1',
    'https://metadata.google.internal/v1']) assert.throws(() => proxyBase(value), error => error.status === 400);
  assert.equal(proxyBase('https://proxy.example.test/v1/'), 'https://proxy.example.test/v1');
});
test('uploaded media must match its extension signature', () => {
  const bytes = (...parts) => Buffer.concat([...parts.map(part => Buffer.isBuffer(part) ? part : Buffer.from(part, 'latin1')), Buffer.alloc(16)]);
  assert.equal(mediaSignature('.wav', bytes('RIFF\0\0\0\0WAVE')), true);
  assert.equal(mediaSignature('.mp4', bytes('\0\0\0\x18ftypisom')), true);
  assert.equal(mediaSignature('.webm', bytes(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))), true);
  assert.equal(mediaSignature('.flac', bytes('fLaC')), true);
  assert.equal(mediaSignature('.wav', bytes('MZ\x90\0')), false);
  assert.equal(mediaSignature('.mp3', Buffer.from('ID3')), false);
});
test('responses carry clickjacking, isolation and permission headers', async () => {
  const store = new Store(':memory:'); const scheduler = new Scheduler(store, { ready: true, metadata: {}, stop: async () => {} }, { chunkSeconds: 5, queueChunks: 4, silenceRms: 0 });
  const service = createService({ store, scheduler, inputs: { stop: async () => {} }, config: { adminToken: admin, viewerToken: viewer },
    schedule: { view: () => null, adminView: () => null, close: async () => {} } });
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
  try {
    const response = await fetch('http://127.0.0.1:' + service.server.address().port + '/');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(response.headers.get('content-security-policy'), /form-action 'self'/);
    assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.match(response.headers.get('permissions-policy'), /camera=\(\)/);
    const vercel = JSON.parse(readFileSync(new URL('../web/vercel.json', import.meta.url)));
    const keys = vercel.headers[0].headers.map(header => header.key);
    for (const key of ['Strict-Transport-Security', 'X-Frame-Options', 'Content-Security-Policy', 'Permissions-Policy']) assert.ok(keys.includes(key));
  } finally { await scheduler.close(); await service.close(); store.close(); }
});
test('secret rotation replaces tokens and re-encrypts stored proxy credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jc-rotate-'));
  try {
    const tokens = join(dir, 'access.secret'); const database = join(dir, 'live.sqlite'); const config = join(dir, 'config.json');
    writeFileSync(tokens, JSON.stringify({ adminToken: admin, viewerToken: viewer }));
    writeFileSync(config, JSON.stringify({ port: 9, tokenFile: tokens, database }));
    const db = new DatabaseSync(database); db.exec('CREATE TABLE ai_settings(id TEXT PRIMARY KEY, document TEXT NOT NULL)');
    const sealed = sealCredential('proxy-key', 'https://proxy.example.test/v1', admin);
    db.prepare('INSERT INTO ai_settings VALUES(?,?)').run('proxy-credential', JSON.stringify(sealed));
    db.prepare('INSERT INTO ai_settings VALUES(?,?)').run('profile:x', JSON.stringify({ id: 'x', credential: sealed })); db.close();
    const { stdout } = await promisify(execFile)(process.execPath, ['scripts/rotate-secrets.mjs', config], { cwd: new URL('..', import.meta.url) });
    assert.equal(JSON.parse(stdout).resealed_credentials, 2);
    const next = JSON.parse(readFileSync(tokens, 'utf8')); assert.notEqual(next.adminToken, admin); assert.notEqual(next.viewerToken, viewer);
    const check = new DatabaseSync(database);
    const stored = JSON.parse(check.prepare("SELECT document FROM ai_settings WHERE id='profile:x'").get().document).credential; check.close();
    assert.equal(openCredential(stored, stored.destination, next.adminToken), 'proxy-key');
    assert.throws(() => openCredential(stored, stored.destination, admin));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('bounded log rotates once the size cap is reached and keeps one previous file', async () => {
  const { boundedLog } = await import('../src/bounded-log.mjs');
  const { mkdtempSync, readFileSync, existsSync, rmSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'jc-log-')); const path = join(dir, 'engine.log');
  try {
    const log = boundedLog(path, 100);
    for (let i = 0; i < 5; i++) log.write('x'.repeat(40) + '\n');
    await new Promise(resolve => log.end(resolve));
    assert.ok(existsSync(path + '.1')); assert.ok(readFileSync(path, 'utf8').length <= 100); assert.ok(readFileSync(path + '.1', 'utf8').length <= 123);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('administrator writes are recorded as structured audit lines without request bodies', async () => {
  const store = new Store(':memory:'); const scheduler = new Scheduler(store, { ready: true, metadata: {}, stop: async () => {} }, { chunkSeconds: 5, queueChunks: 4, silenceRms: 0 });
  const service = createService({ store, scheduler, inputs: { stop: async () => {} }, config: { adminToken: admin, viewerToken: viewer },
    schedule: { view: () => null, adminView: () => null, close: async () => {} } });
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
  const written = []; const original = process.stderr.write; process.stderr.write = chunk => { written.push(String(chunk)); return true; };
  try {
    const base = 'http://127.0.0.1:' + service.server.address().port;
    await fetch(base + '/api/admin/discovery', { method: 'POST', headers: { Authorization: 'Bearer ' + admin, 'Content-Type': 'application/json' }, body: '{"enabled":false,"secret_value":"do-not-log"}' });
    await new Promise(resolve => setTimeout(resolve, 50));
    const audit = written.map(line => JSON.parse(line)).find(entry => entry.event === 'admin.action');
    assert.equal(audit.path, '/api/admin/discovery'); assert.equal(audit.status, 200); assert.doesNotMatch(JSON.stringify(audit), /do-not-log/);
  } finally { process.stderr.write = original; await scheduler.close(); await service.close(); store.close(); }
});
