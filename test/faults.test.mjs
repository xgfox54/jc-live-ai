import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { EventFeed } from '../src/events.mjs';

const config = { chunkSeconds: 5, queueChunks: 12, silenceRms: 0 };
async function drained(scheduler) { while (scheduler.busy) await new Promise(resolve => setImmediate(resolve)); }
function feed(scheduler, id) {
  const channel = scheduler.channel(id);
  for (let i = 0; i < 5; i++) scheduler.feed(id, { session_id: channel.session_id,
    epoch: channel.timeline_epoch, seq: i, pcm: Buffer.alloc(32000) });
}
test('one failed inference records its gap and seven other inputs complete', async () => {
  // Given
  const store = new Store(':memory:'); let first = true;
  const engine = { ready: true, metadata: {}, stop: async () => {}, transcribe: async () => {
    if (first) { first = false; throw new Error('Injected inference failure'); }
    return { spans: [{ text: 'synthetic' }], inference_ms: 1 };
  } };
  const scheduler = new Scheduler(store, engine, config);
  for (let i = 1; i <= 8; i++) scheduler.start({ stream_id: 'ch' + i });
  // When
  for (let i = 1; i <= 8; i++) feed(scheduler, 'ch' + i);
  await drained(scheduler);
  // Then
  assert.equal(scheduler.metrics.errors, 1); assert.equal(scheduler.metrics.gaps, 1);
  assert.equal(scheduler.metrics.jobs, 7); assert.equal(store.snapshot(['ch1']).segments.length, 0);
  await scheduler.close(); store.close();
});
test('restart records interrupted session and persists unknown gap extent', () => {
  // Given
  const store = new Store(':memory:');
  store.saveSession({ session_id: 's1', stream_id: 'ch1', timeline_epoch: 0, state: 'running' });
  // When
  store.recover();
  // Then
  assert.equal(store.states()[0].state, 'interrupted');
  assert.equal(store.events(0).at(-1).payload.extent, 'unknown'); store.close();
});
test('epoch change isolates old in-flight result from new audio positions', async () => {
  // Given
  const store = new Store(':memory:'); let release;
  const engine = { ready: true, metadata: {}, stop: async () => {},
    transcribe: async () => new Promise(resolve => { release = () => resolve({ spans: [{ text: 'old epoch' }], inference_ms: 1 }); }) };
  const scheduler = new Scheduler(store, engine, config); scheduler.start({ stream_id: 'ch1' }); feed(scheduler, 'ch1');
  // When
  scheduler.epoch('ch1'); release(); await drained(scheduler);
  // Then
  assert.equal(scheduler.channel('ch1').audio_processed_until, 0);
  assert.equal(store.snapshot(['ch1']).segments[0].timeline_epoch, 0);
  assert.equal(scheduler.channel('ch1').timeline_epoch, 1);
  await scheduler.close(); store.close();
});
test('slow socket waits for drain instead of losing replay events', async () => {
  // Given
  const store = new Store(':memory:'); const feed = new EventFeed(store);
  for (let i = 0; i < 4; i++) store.event('status', { stream_id: 'ch1', sequence: i });
  const response = new EventEmitter(); const sent = [];
  Object.assign(response, { destroyed: false, writableLength: 0,
    write: wire => { sent.push(wire); return sent.length !== 1; }, end: () => {}, destroy: () => { response.destroyed = true; } });
  const client = { res: response, ids: new Set(['ch1']), cursor: 0, waiting: false, scheduled: false };
  feed.clients.add(client);
  // When
  feed.pump(client); assert.equal(client.waiting, true);
  response.emit('drain'); await new Promise(resolve => setImmediate(resolve));
  // Then
  assert.equal(sent.length, 4); assert.equal(client.cursor, 4); assert.equal(response.destroyed, false);
  feed.close(); store.close();
});
test('client beyond byte ceiling is disconnected with bounded state', () => {
  // Given
  const store = new Store(':memory:'); const feed = new EventFeed(store, { maxBytes: 128 });
  const response = { destroyed: false, writableLength: 129, destroy() { this.destroyed = true; } };
  const client = { res: response, ids: new Set(['ch1']), cursor: 0 };
  feed.clients.add(client);
  // When
  feed.send(client, { event_id: 1, kind: 'status', payload: { stream_id: 'ch1' } });
  // Then
  assert.equal(response.destroyed, true); assert.equal(feed.clients.size, 0);
  assert.equal(feed.metrics.slow_disconnects, 1); feed.close(); store.close();
});
