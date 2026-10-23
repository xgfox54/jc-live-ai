import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.mjs';
import { BroadcastRegistry } from '../src/broadcast-registry.mjs';
import { MinutesService } from '../src/minutes.mjs';
import { CorrectionService } from '../src/ai-correction.mjs';
import { LiveCorrection } from '../src/live-correction.mjs';
import { CloudPublisher } from '../src/cloud-publisher.mjs';
import { syncRequest, viewerRequest } from '../web/lib/http.mjs';

const duration = Number(process.argv[2] ?? 60);
if (!Number.isInteger(duration) || duration < 5 || duration > 7200) throw new Error('Duration must be 5..7200 seconds');
const output = resolve(process.argv[3] ?? 'reports/reliability-second-pass-20261023/PUBLICATION/run-' + Date.now());
mkdirSync(output, { recursive: true });
const input = resolve('.omo/evidence/integrated-real-20261023/smoke/transcripts.json');
const sourceBytes = readFileSync(input); const source = JSON.parse(sourceBytes);
const ids = [...new Set(source.map(row => row.stream_id))].sort();
if (ids.length !== 8) throw new Error('Expected eight recorded channels');
const baseConfig = JSON.parse(readFileSync('config.local.json', 'utf8'));
const tokens = JSON.parse(readFileSync(resolve(baseConfig.tokenFile), 'utf8'));
const original = new DatabaseSync(resolve(baseConfig.database), { readOnly: true });
const setting = id => { const row = original.prepare('SELECT document FROM ai_settings WHERE id=?').get(id); return row ? JSON.parse(row.document) : null; };
const settings = setting('global'); const credential = setting('proxy-credential'); original.close();
if (settings?.provider !== 'proxy' || !settings.model) throw new Error('Existing proxy model required; local providers forbidden');
const store = new Store(':memory:'); const registry = new BroadcastRegistry(store);
const scheduler = { states: () => [], channels: new Map() };
const config = { manualMode: false, adminToken: tokens.adminToken, minutesDirectory: output + '/minutes' };
const requests = []; const abort = new AbortController();
const ai = new CorrectionService({ store, registry, scheduler, config, aiFetch: async (url, options) => {
  if (url !== settings.base + '/chat/completions') throw new Error('Only the configured correction endpoint is permitted');
  const started = Date.now(); const model = JSON.parse(options.body).model;
  try {
    const response = await fetch(url, { ...options, signal: AbortSignal.any([options.signal, abort.signal]) });
    requests.push({ model, started_ms: started, response_ms: Date.now(), status: response.status }); return response;
  } catch (error) { requests.push({ model, started_ms: started, response_ms: Date.now(), error: error.name }); throw error; }
} });
clearInterval(ai.timer);
const originalGet = ai.get.bind(ai);
ai.get = (table, id) => table === 'ai_settings' && id === 'global' ? { ...settings, automatic: true }
  : table === 'ai_settings' && id === 'proxy-credential' ? credential : originalGet(table, id);
const live = new LiveCorrection({ store, registry, ai });
const minutes = new MinutesService({ store, registry, config });
const secret = randomBytes(32).toString('hex');
const rows = new Map(); let writes = 0; const syncStatuses = {};
const storage = { async read(path) { return structuredClone(rows.get(path) ?? null); },
  async write(path, value, previous) {
    if (rows.get(path)?.etag !== previous) throw new Error('Storage revision mismatch');
    rows.set(path, { value: structuredClone(value), etag: String(++writes) });
  } };
const server = createServer(async (req, res) => {
  try {
    const chunks = []; for await (const part of req) chunks.push(part);
    const request = new Request('http://127.0.0.1:' + server.address().port + req.url,
      { method: req.method, headers: req.headers, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
    const response = req.url === '/api/sync' ? await syncRequest(request, { storage, secret }) : await viewerRequest(request, { storage });
    if (req.url === '/api/sync') syncStatuses[response.status] = (syncStatuses[response.status] ?? 0) + 1;
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
  } catch { res.writeHead(500); res.end(); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = 'http://127.0.0.1:' + server.address().port;
const publisher = new CloudPublisher({ config, store, registry, scheduler, minutes,
  settings: { endpoint: base + '/api/sync', secret, interval_ms: 60000, minutes_interval_ms: 300000 } });
const sessions = new Map();
for (const [i, id] of ids.entries()) {
  const page_url = 'https://www.youtube.com/watch?v=' + String(i + 1).padStart(11, '0');
  const record = registry.upsert({ page_url, sources: [page_url], title: 'Stored transcript replay ' + id, kind: 'youtube' });
  const stream = { stream_id: id, name: record.title, page_url, broadcast_id: record.id };
  const session = { session_id: 'replay-' + id, stream_id: id, state: 'running', started_ms: Date.now() };
  store.saveStream(stream); registry.attach(stream, session); store.saveSession(session); sessions.set(id, session.session_id);
}
const versions = new Map(); const produced = [];
store.on('event', event => {
  if (event.kind !== 'segment') return;
  const row = event.payload; const key = row.segment_id + ':' + row.version;
  versions.set(key, { created_ms: event.created_ms, stream_id: row.stream_id, corrected: row.ai_corrected === true });
  produced.push({ key, created_ms: event.created_ms, stream_id: row.stream_id, corrected: row.ai_corrected === true });
});
const clients = Array.from({ length: 300 }, (_, i) => ({ id: i, streams: [ids[(i * 2) % 8], ids[(i * 2 + 1) % 8]], polls: 0, errors: 0, error_details: [], statuses: {}, seen: new Map(), etag: null }));
const latency = []; let polling = true;
async function poll(client) {
  try {
    const response = await fetch(base + '/api/viewer/snapshot?streams=' + ids.join(',') + '&text_streams=' + client.streams.join(','),
      { headers: client.etag ? { 'If-None-Match': client.etag } : {}, signal: AbortSignal.timeout(10000) });
    client.polls++; client.statuses[response.status] = (client.statuses[response.status] ?? 0) + 1;
    if (response.status === 304) return;
    if (!response.ok) { client.errors++; await response.arrayBuffer(); return; }
    client.etag = response.headers.get('etag'); const snapshot = await response.json();
    for (const row of [...snapshot.segments, ...snapshot.live_segments]) {
      if (!client.streams.includes(row.stream_id)) throw new Error('Unselected channel text');
      const key = row.segment_id + ':' + row.version;
      if (!client.seen.has(key)) {
        const received = Date.now(); client.seen.set(key, received); const sent = versions.get(key);
        if (sent) latency.push({ client: client.id, key, corrected: sent.corrected, ms: received - sent.created_ms });
      }
    }
  } catch (error) { client.errors++; client.error_details.push({ at_ms: Date.now(), name: error.name, message: error.message, code: error.cause?.code ?? null }); }
}
await publisher.flush();
const loops = clients.map(async client => {
  await new Promise(resolve => setTimeout(resolve, client.id * 3));
  while (polling) { await poll(client); await new Promise(resolve => setTimeout(resolve, 5000)); }
});
const begun = Date.now();
const hardDeadline = setTimeout(() => { writeFileSync(output + '/deadline.json', JSON.stringify({ exceeded: true, elapsed_ms: Date.now() - begun })); process.exit(2); }, (duration + 65) * 1000);
let summary;
try {
  await publisher.flush(); publisher.start();
  const replay = [];
  for (let cycle = 0; cycle * 60000 < duration * 1000; cycle++) {
    for (const row of source) {
      const due = cycle * 60000 + row.end_ms;
      if (due <= duration * 1000) replay.push({ row, due, cycle });
    }
  }
  replay.sort((a, b) => a.due - b.due);
  for (const { row, due, cycle } of replay) {
    await new Promise(resolve => setTimeout(resolve, Math.max(0, begun + due - Date.now())));
    store.segment({ ...row, session_id: sessions.get(row.stream_id), start_ms: row.start_ms + cycle * 60000,
      end_ms: row.end_ms + cycle * 60000, live_preview: true, preview_updated_ms: Date.now(), ready_ms: Date.now(), audio_received_ms: Date.now() });
  }
  await new Promise(resolve => setTimeout(resolve, Math.max(0, begun + duration * 1000 - Date.now())));
  const drainUntil = Date.now() + 45000;
  while ((live.inflight.size || live.waiting.size || live.refining.size) && Date.now() < drainUntil) await new Promise(resolve => setTimeout(resolve, 100));
  const unresolvedAtDeadline = { inflight: live.inflight.size, waiting: live.waiting.size, refining: live.refining.size };
  abort.abort(); await live.close(); await publisher.flush({ force: true });
  polling = false; await Promise.all(loops); await Promise.all(clients.map(async client => { await new Promise(resolve => setTimeout(resolve, client.id * 3)); await poll(client); }));
  const latest = new Map(); for (const event of produced) latest.set(event.key.split(':')[0], event);
  const expected = clients.map(client => {
    const selected = [...latest.values()].filter(row => client.streams.includes(row.stream_id) && row.corrected);
    return { id: client.id, expected_corrected: selected.length, received_corrected: selected.filter(row => client.seen.has(row.key)).length };
  });
  const stats = values => { const sorted = values.slice().sort((a,b) => a-b); return { count: sorted.length, p50_ms: sorted[Math.floor(sorted.length*.5)] ?? null, p95_ms: sorted[Math.floor(sorted.length*.95)] ?? null, max_ms: sorted.at(-1) ?? null }; };
  summary = { source: 'Stored real Whisper transcript replay; no fresh inference; localhost clients, not Internet users', input, input_sha256: createHash('sha256').update(sourceBytes).digest('hex'),
    duration_requested_s: duration, elapsed_s: (Date.now()-begun)/1000, replayed_segments: replay.length, channels: ids, clients: clients.length,
    configured_models: { fast: settings.model, refine: settings.refine_model }, automatic_enabled_only_in_isolation: true,
    live_correction: live.metrics, unresolvedAtDeadline, proxy_requests: requests.length, request_errors: requests.filter(r => r.error || r.status >= 400).length,
    request_aborted: requests.filter(r => r.error === 'AbortError').length, http_errors: requests.filter(r => r.status >= 400).length,
    storage_writes: writes, syncStatuses, publisher: publisher.view(), client_errors: clients.reduce((n,c) => n+c.errors,0),
    delivery_latency: stats(latency.map(row => row.ms)), corrected_delivery_latency: stats(latency.filter(row => row.corrected).map(row => row.ms)),
    missing_latest_corrected_deliveries: expected.reduce((n,c) => n+c.expected_corrected-c.received_corrected,0), expected };
  writeFileSync(output + '/summary.json', JSON.stringify(summary, null, 2));
  writeFileSync(output + '/proxy-requests.json', JSON.stringify(requests, null, 2));
  writeFileSync(output + '/deliveries.json', JSON.stringify(latency));
  writeFileSync(output + '/clients.json', JSON.stringify(clients.map(c => ({ ...c, seen: [...c.seen], etag: undefined }))));
  writeFileSync(output + '/produced.json', JSON.stringify(produced));
  console.log(JSON.stringify(summary, null, 2));
  if (summary.client_errors || summary.missing_latest_corrected_deliveries || !summary.live_correction.applied || summary.publisher.live_phase !== 'published') process.exitCode = 1;
} finally {
  polling = false; abort.abort(); await live.close(); await publisher.close(); await ai.close(); minutes.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); clearTimeout(hardDeadline);
}
