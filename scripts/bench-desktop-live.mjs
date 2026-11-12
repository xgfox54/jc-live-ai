import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store } from '../src/store.mjs';
import { createDesktopLive } from '../src/desktop-live.mjs';
import { retryWithJitter } from '../public/polling.mjs';

const output = resolve(process.argv[2] ?? 'reports/desktop-live'); mkdirSync(output, { recursive: true });
const clients = 300; const rounds = 20; const streams = Array.from({ length: 8 }, (_, i) => 'ch' + (i + 1));
const origin = 'https://synthetic.example.org'; const store = new Store(':memory:');
const gateway = createDesktopLive({ store, scheduler: { states: () => [] }, config: {
  desktopLive: { enabled: true, port: 0, publicOrigin: 'https://live.example.org', allowedOrigins: [origin] } } });
for (const id of streams) {
  store.saveStream({ stream_id: id, name: id }); store.saveSession({ stream_id: id, session_id: id + '-session', state: 'running' });
}
const startMemory = process.memoryUsage().rss; const started = performance.now();
const connections = []; const emitted = new Map(); const latency = []; const errors = [];
let received = 0; let expected = 0; let base;
let connectionRetries = 0;
const request = (url, options) => retryWithJitter(async () => {
  try { return await fetch(url, options); } catch (error) { connectionRetries++; throw error; }
}, { baseMs: 1000 });
const waitFor = async (check, label) => {
  const deadline = performance.now() + 15000;
  while (!check()) {
    if (errors.length) throw new Error(errors[0]);
    if (performance.now() > deadline) throw new Error('Timed out: ' + label);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
async function connect(cursor) {
  const controller = new AbortController();
  const response = await request(base + '/api/viewer/events?streams=' + streams.join(',') + '&after=' + cursor,
    { headers: { Origin: origin }, signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(); const connection = { reader, controller, cursor, seen: new Set() };
  connections.push(connection);
  connection.reading = (async () => {
    let buffer = ''; const decoder = new TextDecoder();
    try {
      while (true) {
        const part = await reader.read(); if (part.done) return; buffer += decoder.decode(part.value, { stream: true });
        for (let end; (end = buffer.indexOf('\n\n')) >= 0;) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = block.split('\n').find(line => line.startsWith('data: ')); if (!data) continue;
          const event = JSON.parse(data.slice(6)); connection.cursor = event.event_id;
          if (event.kind !== 'live-segment') continue;
          assert.equal(connection.seen.has(event.event_id), false); connection.seen.add(event.event_id); received++;
          assert.ok(streams.includes(event.payload.stream_id)); assert.ok(event.payload.text.includes(event.payload.stream_id));
          assert.equal('raw_text' in event.payload, false);
          if (emitted.has(event.event_id)) latency.push(performance.now() - emitted.get(event.event_id));
        }
      }
    } catch (error) { if (!controller.signal.aborted) errors.push(error.message); }
  })();
  return connection;
}
const stop = async connection => { connection.controller.abort(); await connection.reading; };
let result;
try {
  await gateway.start(); base = 'http://127.0.0.1:' + gateway.server.address().port;
  const responses = await Promise.all(Array.from({ length: clients }, () => request(base + '/api/viewer/snapshot?text_streams=ch1,ch2', { headers: { Origin: origin } })));
  assert.ok(responses.every(response => response.status === 200)); await Promise.all(responses.map(response => response.json()));
  await Promise.all(Array.from({ length: clients }, () => connect(store.cursor())));
  assert.equal(gateway.feed.clients.size, clients);
  for (let round = 0; round < rounds; round++) {
    const rows = streams.map(id => {
      const stamp = performance.now();
      const row = store.segment({ stream_id: id, session_id: id + '-session', start_ms: round * 10000, end_ms: (round + 1) * 10000,
        raw_text: '합성 ' + id + ' 받아쓰기 ' + round, live_preview: true });
      emitted.set(store.cursor(), stamp); return row;
    });
    expected += clients * streams.length; await waitFor(() => received === expected, 'draft delivery');
    for (const row of rows) {
      const stamp = performance.now(); store.correct(row.segment_id, { version: 1, origin: 'ai', text: '합성 ' + row.stream_id + ' 후보정 ' + round });
      emitted.set(store.cursor(), stamp);
    }
    expected += clients * streams.length; await waitFor(() => received === expected, 'correction delivery');
  }
  const reconnecting = connections.slice(0, 50); await Promise.all(reconnecting.map(stop));
  const missed = store.segment({ stream_id: 'ch1', session_id: 'ch1-session', start_ms: rounds * 10000, end_ms: (rounds + 1) * 10000,
    raw_text: '합성 ch1 재연결 중 발언', live_preview: true });
  emitted.set(store.cursor(), performance.now());
  await Promise.all(reconnecting.map(connection => connect(connection.cursor)));
  expected += clients; await waitFor(() => received === expected, 'reconnect replay');
  assert.equal(store.segments({ stream: 'ch1' }).items.some(row => row.segment_id === missed.segment_id), true);
  const sorted = latency.sort((a, b) => a - b);
  result = { passed: true, method: 'Synthetic text over actual loopback HTTP/SSE; no audio, GPU, external tunnel or Vercel calls',
    clients, streams: streams.length, rounds, expected, received, duplicate_or_channel_errors: errors.length, reconnects: 50, connectionRetries,
    elapsed_ms: performance.now() - started, latency_ms: { p50: sorted[Math.floor(sorted.length * 0.5)], p95: sorted[Math.floor(sorted.length * 0.95)], p99: sorted[Math.floor(sorted.length * 0.99)], max: sorted.at(-1) },
    rss_delta_bytes: process.memoryUsage().rss - startMemory, feed: gateway.feed.metrics };
} catch (error) { result = { passed: false, error: error.message, cause: error.cause?.message, code: error.cause?.code, stack: error.stack, expected, received, errors }; process.exitCode = 1; }
finally {
  await Promise.all(connections.map(stop)); await gateway.close(); store.close();
  writeFileSync(join(output, 'load-result.json'), JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result, null, 2));
}
