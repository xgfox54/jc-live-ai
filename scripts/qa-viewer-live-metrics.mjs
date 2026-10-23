import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { connectViewers, viewerSummary } from './viewer-client.mjs';

const output = resolve(process.argv[2]); mkdirSync(output, { recursive: true });
const responses = new Set();
const server = createServer((request, response) => {
  assert.match(request.url, /^\/api\/viewer\/events\?/);
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  response.flushHeaders(); responses.add(response);
  request.on('close', () => responses.delete(response));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
let viewers = [];
try {
  ({ viewers } = await connectViewers('http://127.0.0.1:' + server.address().port, '', 3, true));
  for (const version of [1, 2]) {
    const event = { event_id: version, kind: 'live-segment', payload: { stream_id: 'ch1', segment_id: 'metric-fixture',
      version, start_ms: 0, end_ms: 5000, audio_received_ms: Date.now() - 1000, text: 'SSE metric fixture' } };
    for (const response of responses) response.write('id: ' + version + '\ndata: ' + JSON.stringify(event) + '\n\n');
  }
  const deadline = Date.now() + 5000;
  while (viewers.some(viewer => viewer.versions.get('metric-fixture') !== 2) && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 10));
  const summary = viewerSummary(viewers); const readiness = summary.readiness_including_transport[0];
  assert.equal(summary.received_events, 6); assert.equal(summary.live_segment_deliveries, 6);
  assert.equal(summary.minimum_segment_versions, 1); assert.equal(summary.duplicates, 0);
  assert.ok(viewers.every(viewer => viewer.versions.get('metric-fixture') === 2));
  assert.equal(readiness.samples, 6); assert.ok(readiness.p95_ms >= 6000 && readiness.p95_ms < 11000);
  writeFileSync(output + '/result.json', JSON.stringify({ pass: true,
    scenario: 'Three actual public HTTP SSE connections receive two synthetic live-segment versions without created_ms or latency_ms.',
    scope: 'Viewer measurement regression only; no ASR inference or load capacity claim.', summary }, null, 2));
} finally {
  viewers.forEach(viewer => viewer.close()); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
