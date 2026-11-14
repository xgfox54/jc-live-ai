import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.mjs';
import { EventFeed } from '../src/events.mjs';

test('clients of the same channel share one projection and one read of each event', async t => {
  // Given three viewers connected to the same channel
  const store = new Store(':memory:'); let projections = 0; let reads = 0;
  const events = store.events.bind(store); store.events = (...args) => { reads++; return events(...args); };
  const feed = new EventFeed(store, { project: event => { projections++; return event; } });
  t.after(() => { feed.close(); store.close(); });
  const responses = [1, 2, 3].map(() => {
    const res = Object.assign(new EventEmitter(), { destroyed: false, writableLength: 0, chunks: [],
      writeHead() {}, flushHeaders() {}, end() {}, destroy() { this.destroyed = true; }, write(chunk) { this.chunks.push(chunk); return true; } });
    feed.connect(new EventEmitter(), res, ['ch1'], store.cursor()); return res;
  });
  for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
  projections = 0; reads = 0;
  // When one event arrives
  store.event('status', { stream_id: 'ch1', state: 'running' });
  for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
  // Then every viewer receives it, but it is read and projected once
  for (const res of responses) assert.match(res.chunks.at(-1), /"state":"running"/);
  assert.equal(projections, 1); assert.equal(reads, 1);
});
