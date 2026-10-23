import test from 'node:test';
import assert from 'node:assert/strict';
import { pollSnapshots } from '../public/polling.mjs';
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
