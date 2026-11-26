import test from 'node:test';
import assert from 'node:assert/strict';
import { pollSnapshots } from '../public/polling.mjs';
import { subscribe, RecentEvents } from '../public/subscription.mjs';
import { viewerHealthMessage } from '../public/client-state.mjs';

test('stalled snapshot request is cancelled and polling recovers', async () => {
  const controller = new AbortController();
  let requests = 0; let stalledSignal; const connections = [];
  await pollSnapshots({ signal: controller.signal, interval: 1, timeoutMs: 20,
    refresh: ({ signal }) => {
      requests++;
      if (requests === 1) { stalledSignal = signal; return new Promise(() => {}); }
      assert.equal(stalledSignal.aborted, true);
      return Promise.resolve();
    }, connection: value => { connections.push(value); if (value) controller.abort(); }
  });
  assert.equal(requests, 2);
  assert.deepEqual(connections, [false, true]);
});

test('closing a viewer cancels an in-flight request without another refresh', async () => {
  const controller = new AbortController(); let child;
  await pollSnapshots({ signal: controller.signal, interval: 1, timeoutMs: 1000,
    refresh: ({ signal }) => { child = signal; controller.abort(); return new Promise(() => {}); },
    connection: () => assert.fail('Closed viewer must not update connection status') });
  assert.equal(child.aborted, true);
});

test('recent successful corrections distinguish partial backlog from a stalled correction pipeline', () => {
  const now = 1_000_000;
  const health = { status: 'correction_delayed', last_received_ms: now - 1000, last_corrected_ms: now - 5000 };
  assert.match(viewerHealthMessage(health, now), /^일부 문장의 후보정/);
  assert.match(viewerHealthMessage({ ...health, last_corrected_ms: now - 90000 }, now), /^AI 후보정이 지연/);
  assert.match(viewerHealthMessage(health, now + 190000), /^AI 후보정이 지연/);
});

test('a viewer whose event stream is alive skips the snapshot until its check is due', async () => {
  // Given a caller that reports current data for the first three wake-ups
  const controller = new AbortController(); let wakes = 0; let requests = 0;
  await pollSnapshots({ signal: controller.signal, interval: 1, connection() {},
    sleep: async () => { wakes++; }, skip: () => wakes <= 3,
    refresh: async () => { requests++; controller.abort(); } });
  // Then the snapshot was requested once, on the fourth wake-up
  assert.equal(wakes, 4); assert.equal(requests, 1);
});

test('the event stream reports each delivery so the page knows the stream is alive', async () => {
  // Given a stream that answers, sends two chunks (the second a heartbeat) and ends
  const controller = new AbortController(); const encoder = new TextEncoder(); let received = 0;
  const body = new ReadableStream({ start(stream) {
    stream.enqueue(encoder.encode(': connected\n\n'));
    stream.enqueue(encoder.encode('id: 0\ndata: {"kind":"heartbeat","event_id":0,"payload":{}}\n\n'));
    stream.close();
  } });
  await subscribe({ signal: controller.signal, ids: ['ch0'], state: { cursor: 0, apply: () => false },
    api: async () => ({ body }), changed() {}, refresh: async () => {}, received: () => { received++; },
    connection: value => { if (value === '재연결 대기') controller.abort(); } });
  // Then the page heard of the answer and of both chunks
  assert.equal(received, 3);
});

test('events newer than a snapshot read beside the open stream are applied again', () => {
  let now = 0; const recent = new RecentEvents({ now: () => now });
  // Given the stream opened at a snapshot with event 10 and delivered events 11 to 13
  assert.deepEqual(recent.after(10), []);
  for (const id of [11, 12, 13]) recent.add({ event_id: id });
  // When a snapshot built at event 12 arrives, then only event 13 is applied again
  assert.deepEqual(recent.after(12).map(event => event.event_id), [13]);
  assert.deepEqual(recent.after(13), []);
  // When events older than a minute were dropped, a snapshot older than them cannot be completed
  now = 61_000; recent.add({ event_id: 14 });
  assert.equal(recent.after(12), null);
  assert.deepEqual(recent.after(13).map(event => event.event_id), [14]);
  // After clear the next snapshot is the new start
  recent.clear(); assert.deepEqual(recent.after(5), []);
});

test('the stream keeps the events it applied, without the health heartbeat', async () => {
  const controller = new AbortController(); const encoder = new TextEncoder(); const recent = new RecentEvents();
  const body = new ReadableStream({ start(stream) {
    stream.enqueue(encoder.encode('id: 5\ndata: {"kind":"status","event_id":5,"payload":{"stream_id":"ch0"}}\n\n'
      + 'id: 5\ndata: {"kind":"delivery-health","event_id":5,"payload":{}}\n\n'));
    stream.close();
  } });
  await subscribe({ signal: controller.signal, ids: ['ch0'], state: { cursor: 0, apply: () => true }, recent,
    api: async () => ({ body }), changed() {}, refresh: async () => {},
    connection: value => { if (value === '재연결 대기') controller.abort(); } });
  assert.deepEqual(recent.after(0).map(event => event.kind), ['status']);
});
