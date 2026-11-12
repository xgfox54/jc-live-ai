// Read-only gateway in front of the standby laptop engine, reached by the Worker through a Cloudflare quick tunnel.
// It answers only requests carrying the laptop key and only while this laptop holds the standby lease
// (docs/LAPTOP-STANDBY.md). Usage: node scripts/standby/live-gateway.mjs [config.local.json]
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const root = fileURLToPath(new URL('../../', import.meta.url));
const config = JSON.parse(readFileSync(resolve(root, process.argv[2] ?? 'config.local.json'), 'utf8'));
if (!config.standbyLeaseFile) throw new Error('Set standbyLeaseFile in the standby engine configuration');
const state = resolve(root, 'data/standby'); mkdirSync(state, { recursive: true });
const secretPath = resolve(state, 'gateway.secret');
if (!existsSync(secretPath)) writeFileSync(secretPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
const secret = readFileSync(secretPath, 'utf8').trim();
const leasePath = resolve(root, config.standbyLeaseFile);
const engine = 'http://127.0.0.1:' + (config.port ?? 4320);
const paths = new Set(['/api/viewer/snapshot', '/api/viewer/events', '/api/viewer/segments', '/api/viewer/schedule', '/api/viewer/status']);
const leased = () => {
  try { const lease = JSON.parse(readFileSync(leasePath, 'utf8')); return lease.role === 'laptop' && lease.valid_until > Date.now(); }
  catch (error) { if (!(error instanceof Error)) throw error; return false; }
};
http.createServer(async (req, res) => {
  const key = req.headers['x-jc-laptop-key'];
  if (typeof key !== 'string' || key.length !== secret.length || !timingSafeEqual(Buffer.from(key), Buffer.from(secret))) {
    res.writeHead(403); res.end(); return;
  }
  const url = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET' || !paths.has(url.pathname) || url.search.length > 2048) { res.writeHead(404); res.end(); return; }
  if (!leased()) { res.writeHead(503, { 'Cache-Control': 'no-store' }); res.end(); return; }
  const abort = new AbortController(); res.on('close', () => abort.abort());
  // An open stream ends within 2 seconds after the lease lapses, so its viewers move back to the desktop.
  const leaseTimer = setInterval(() => { if (!leased()) abort.abort(); }, 2000);
  res.on('close', () => clearInterval(leaseTimer));
  try {
    // Engines without the status route answer it from the snapshot.
    const upstream = await fetch(engine + (url.pathname === '/api/viewer/status' ? '/api/viewer/snapshot?text_streams=' : url.pathname + url.search), {
      signal: abort.signal, redirect: 'error', headers: req.headers['if-none-match'] ? { 'If-None-Match': req.headers['if-none-match'] } : {} });
    const headers = { 'Cache-Control': 'no-store' };
    for (const name of ['content-type', 'etag', 'retry-after', 'x-accel-buffering']) if (upstream.headers.has(name)) headers[name] = upstream.headers.get(name);
    if (upstream.ok && url.pathname === '/api/viewer/snapshot') {
      const data = await upstream.json(); data.engine ??= 'running';
      headers['content-type'] = 'application/json; charset=utf-8';
      res.writeHead(200, headers); res.end(JSON.stringify(data));
    } else {
      res.writeHead(upstream.status, headers);
      if (upstream.body) {
        const stream = Readable.fromWeb(upstream.body);
        stream.on('error', () => { if (!res.destroyed) res.destroy(); });
        stream.pipe(res);
      } else res.end();
    }
  } catch { if (!res.headersSent) res.writeHead(503); res.end(); }
}).listen(4321, '127.0.0.1', () => console.log('gateway.ready'));
