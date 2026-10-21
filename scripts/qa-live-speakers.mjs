import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { createService } from '../src/server.mjs';
import { initializeCommitteeChannels } from '../src/committees.mjs';

const directory = resolve(process.argv[2]); await mkdir(directory, { recursive: true });
const store = new Store(':memory:'); initializeCommitteeChannels(store);
const config = { adminToken: randomBytes(32).toString('hex'), viewerToken: randomBytes(32).toString('hex'),
  chunkSeconds: 10, queueChunks: 12, silenceRms: 0, minutesDirectory: directory + '/minutes' };
const scheduler = new Scheduler(store, { ready: true, stop: async () => {} }, config);
const service = createService({ store, scheduler, config, inputs: { stop: async () => {} } });
const rows = [];
for (const channel of [4, 5]) {
  const stream = store.streams().find(item => item.stream_id === 'ch' + channel);
  const session_id = 'speaker-qa-' + channel;
  store.saveSession({ stream_id: stream.stream_id, session_id, state: 'stopped' });
  service.minutes.attach(stream, { session_id });
  for (const [index, state] of ['assigned', 'multiple', 'pending', 'unknown', 'unavailable'].entries()) {
    const row = store.segment({ stream_id: stream.stream_id, session_id, timeline_epoch: 0,
      start_ms: index * 10000, end_ms: (index + 1) * 10000, raw_text: '원문비공개검사',
      speaker_scope: 'scope-channel-' + channel, speaker_state: state, speaker_method: 'nemotron-streaming',
      speaker_id: state === 'assigned' ? 8 : null, speaker_turns: state === 'multiple'
        ? [{ start_ms: index * 10000, end_ms: index * 10000 + 5000, speaker_id: 1 },
          { start_ms: index * 10000 + 5000, end_ms: (index + 1) * 10000, speaker_id: 8 }] : [] });
    if (state !== 'unavailable') store.correct(row.segment_id, { version: row.version,
      text: '방송 ' + channel + ' 후보정 공개 문장 ' + (index + 1), origin: 'ai' });
    rows.push(row);
  }
}
service.minutes.flush(); service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
const base = 'http://127.0.0.1:' + service.server.address().port;
const snapshot = await (await fetch(base + '/api/viewer/snapshot')).text();
assert.doesNotMatch(snapshot, /원문비공개검사|raw_text/);
assert.match(snapshot, /scope-channel-4/); assert.match(snapshot, /scope-channel-5/);
assert.doesNotMatch(snapshot, /unavailable/);
const evidence = { fixture: 'Synthetic AI-applied text; no external AI request; isolated SQLite in memory',
  base, raw_hidden: true, uncorrected_hidden: true, separate_scopes: true };
await writeFile(directory + '/fixture.json', JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ event: 'fixture.ready', base }));
process.on('message', async message => {
  if (message !== 'finalize') return;
  for (const row of rows.filter(item => item.speaker_state === 'pending'))
    store.annotateSpeakers(row.segment_id, { speaker_scope: row.speaker_scope, speaker_id: 2,
      speaker_state: 'assigned', speaker_turns: [], speaker_method: 'nemotron-streaming' });
  evidence.late_labels_sent = true; await writeFile(directory + '/fixture.json', JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ event: 'fixture.finalized' }));
});
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  await scheduler.close(); await service.close(); store.close(); process.disconnect?.(); clearTimeout(deadline);
}
const deadline = setTimeout(stop, 600000);
process.on('SIGINT', stop); process.on('SIGTERM', stop);
