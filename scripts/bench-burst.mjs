import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { retryWithJitter } from '../public/polling.mjs';
import { viewerRequest } from '../web/lib/http.mjs';

// Sends 300 snapshot requests in the same instant, the way viewers arrive when a meeting starts,
// and applies the browser's first-load retry. "local" serves a fixture through the real viewer handler.
const [target = 'local', outputPath, countText = '300'] = process.argv.slice(2);
if (!outputPath) throw new Error('Usage: bench-burst.mjs <local|https://host> <new output dir> [clients]');
const output = resolve(outputPath);
if (existsSync(output)) throw new Error('Use a new output directory');
mkdirSync(output, { recursive: true });
const count = Number(countText);
if (!Number.isInteger(count) || count < 1 || count > 300) throw new Error('Clients must be 1..300');
let server; let base = target;
if (target === 'local') {
  const site = { kind: 'snapshot', published_ms: Date.now(), minutes_index: [], snapshot: { event_id: 0, streams: [], segments: [],
    live_segments: [], states: [], gaps: [], before: {} } };
  const storage = { read: async path => (path === 'site.json' ? { value: site, etag: '1' } : null) };
  server = createServer(async (req, res) => {
    const response = await viewerRequest(new Request('http://127.0.0.1' + req.url, { headers: req.headers }), { storage });
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = 'http://127.0.0.1:' + server.address().port;
} else if (!/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(target)) throw new Error('Only local or an https *.vercel.app origin');
const ids = Array.from({ length: 13 }, (_, i) => 'ch' + i);
const clients = Array.from({ length: count }, (_, i) => ({ id: i, streams: [ids[(i * 2) % 13], ids[(i * 2 + 1) % 13]], attempts: [], ok: false }));
let release; const gate = new Promise(resolve => { release = resolve; });
const started = Date.now();
const runs = clients.map(async client => {
  await gate;
  try {
    await retryWithJitter(async () => {
      const at = Date.now();
      let response;
      try {
        response = await fetch(base + '/api/viewer/snapshot?text_streams=' + client.streams.join(','), { signal: AbortSignal.timeout(15000) });
        await response.arrayBuffer();
      } catch (error) {
        client.attempts.push({ ms: Date.now() - at, error: error.cause?.code ?? error.name });
        throw error;
      }
      client.attempts.push({ ms: Date.now() - at, status: response.status, cache: response.headers.get('x-vercel-cache') });
      if (!response.ok) throw Object.assign(new Error('HTTP ' + response.status), { retry: response.status >= 500 || response.status === 429 });
    });
    client.ok = true; client.total_ms = Date.now() - started;
  } catch { client.total_ms = Date.now() - started; }
});
release(); await Promise.all(runs); server?.close();
const firsts = clients.map(c => c.attempts[0]);
const count_by = (rows, key) => rows.reduce((map, row) => { const k = String(row?.[key] ?? 'none'); map[k] = (map[k] ?? 0) + 1; return map; }, {});
const sorted = clients.filter(c => c.ok).map(c => c.total_ms).sort((a, b) => a - b);
const summary = { at: new Date().toISOString(), target: target === 'local' ? 'local fixture through web/lib/http.mjs' : target, clients: count,
  first_attempt_failures: firsts.filter(a => a.error || a.status >= 400).length,
  first_attempt_errors: count_by(firsts.filter(a => a.error), 'error'), first_attempt_status: count_by(firsts, 'status'),
  first_attempt_cache: count_by(firsts, 'cache'), retried_clients: clients.filter(c => c.attempts.length > 1).length,
  final_failures: clients.filter(c => !c.ok).length,
  ready_p50_ms: sorted[Math.floor(sorted.length * 0.5)] ?? null, ready_p95_ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
  ready_max_ms: sorted.at(-1) ?? null };
writeFileSync(output + '/clients.json', JSON.stringify(clients, null, 2));
writeFileSync(output + '/summary.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
if (summary.final_failures) process.exitCode = 1;

