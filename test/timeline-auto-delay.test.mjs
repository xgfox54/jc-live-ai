import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialPlayer, evaluateSeek } from '../public/player.mjs';

test('manual probe cannot attach an old session clock after source replacement', async () => {
  const f = fixture();
  f.owner.player.playVideo = () => {};
  const pending = f.owner.probe({ liveEdge: 120, audioMs: 1000, playerSeconds: 90, session: 'old', epoch: 0 });
  f.owner.dispose();
  f.owner.ready = true;
  f.owner.player = { getCurrentTime: () => 91.5, getPlayerState: () => 1 };
  const result = await pending;
  assert.equal(result.supported, false);
  assert.equal(f.owner.anchor, null);
  assert.equal(f.owner.clock({ session_id: 'old', timeline_epoch: 0 }), null);
});

test('manual probe rejects a matching but paused readback', async () => {
  const f = fixture();
  f.owner.player.playVideo = () => {};
  f.owner.player.getPlayerState = () => 2;
  const result = await f.owner.probe({ liveEdge: 120, audioMs: 1000, playerSeconds: 90, session: 'one', epoch: 0 });
  assert.equal(result.supported, false);
  assert.equal(f.owner.anchor, null);
});

test('manual probe retains a supplied matching clock only while its session is playing', async () => {
  const f = fixture();
  f.owner.player.playVideo = () => {};
  const result = await f.owner.probe({ liveEdge: 120, audioMs: 1000, playerSeconds: 90, session: 'one', epoch: 3 });
  assert.equal(result.supported, true);
  assert.deepEqual(f.owner.clock({ session_id: 'one', timeline_epoch: 3 }), { session: 'one', epoch: 3, audioMs: 1000 });
  assert.equal(f.owner.clock({ session_id: 'one', timeline_epoch: 4 }), null);
});

function fixture({ live = true, seekable = true, wait } = {}) {
  let edge = 120; let time = 120;
  const seeks = []; const messages = [];
  const owner = new OfficialPlayer({ replaceChildren() {} }, value => messages.push(value), {
    viewer: true, delayWait: wait ?? (async () => { if (live) edge += 1.5; time += 1.5; })
  });
  owner.ready = true; owner.selection = 1;
  owner.player = { getDuration: () => edge, getCurrentTime: () => time, getPlayerState: () => 1,
    seekTo(value) { seeks.push(value); if (seekable) time = value; }, destroy() {} };
  return { owner, seeks, messages };
}

test('viewer automatically seeks growing live duration back 30 seconds and verifies readback', async () => {
  const f = fixture();
  await f.owner.autoDelay();
  assert.deepEqual(f.seeks, [91.5]);
  assert.equal(f.owner.delayStatus.state, 'applied');
  assert.equal(f.owner.anchor, null);
  assert.equal(f.owner.clock({ session_id: 'one', timeline_epoch: 0 }), null);
  await f.owner.autoDelay();
  assert.equal(f.seeks.length, 1);
});

test('viewer waits for segment-based live duration refresh before declaring DVR unavailable', async () => {
  let waits = 0; let edge = 120;
  const f = fixture({ wait: async () => { if (++waits === 4) edge += 6; } });
  f.owner.player.getDuration = () => edge;
  await f.owner.autoDelay();
  assert.deepEqual(f.seeks, [96]);
  assert.equal(f.owner.delayStatus.state, 'applied');
});

test('VOD duration does not trigger a live delay seek', async () => {
  const f = fixture({ live: false }); await f.owner.autoDelay();
  assert.equal(f.seeks.length, 0); assert.equal(f.owner.delayStatus.state, 'unavailable');
});

test('DVR rejection never reports applied delay or transcript synchronization', async () => {
  const f = fixture({ seekable: false }); await f.owner.autoDelay();
  assert.equal(f.owner.delayStatus.state, 'unavailable'); assert.equal(f.owner.anchor, null);
});

test('source replacement cancels pending automatic seek', async () => {
  let resume;
  const f = fixture({ wait: () => new Promise(resolve => { resume = resolve; }) });
  const pending = f.owner.autoDelay(); f.owner.dispose(); resume(); await pending;
  assert.equal(f.seeks.length, 0);
});

test('invalid readback cannot pass seek verification', () => {
  for (const value of [null, undefined, NaN, '60']) assert.equal(evaluateSeek(value, 60).supported, false);
});

test('paused viewer never seeks or resumes playback', async () => {
  const f = fixture(); f.owner.player.getPlayerState = () => 2;
  await f.owner.autoDelay(); assert.equal(f.seeks.length, 0);
});

test('pause during observation cancels seek and permits later playing attempt', async () => {
  const f = fixture({ wait: async () => { f.owner.player.getPlayerState = () => 2; } });
  await f.owner.autoDelay(); assert.equal(f.seeks.length, 0); assert.equal(f.owner.delayStatus.state, 'idle');
});

test('invalid duration and too-short live window never cause a seek', async () => {
  for (const duration of [0, 15, NaN, undefined]) {
    const f = fixture(); f.owner.player.getDuration = () => duration;
    await f.owner.autoDelay(); assert.equal(f.seeks.length, 0); assert.equal(f.owner.delayStatus.state, 'unavailable');
  }
});

test('source replacement after seek cannot publish stale success', async () => {
  let calls = 0;
  const f = fixture({ wait: async () => { if (++calls === 2) f.owner.dispose(); } });
  let edge = 120; f.owner.player.getDuration = () => edge += 1.5;
  await f.owner.autoDelay(); assert.equal(f.seeks.length, 1); assert.equal(f.owner.delayStatus.state, 'idle');
  assert.equal(f.messages.some(message => message.includes('확인했습니다')), false);
});

test('iframe PLAYING event invokes automatic delay and pause invalidates confirmation', async () => {
  const previous = { YT: globalThis.YT, document: globalThis.document, location: globalThis.location };
  let events; let edge = 120; let time = 120; const seeks = [];
  globalThis.document = { createElement: () => ({}) }; globalThis.location = { origin: 'http://localhost' };
  globalThis.YT = { Player: class {
    constructor(host, options) { events = options.events; }
    getDuration() { return edge; } getCurrentTime() { return time; } getPlayerState() { return 1; }
    seekTo(target) { seeks.push(target); time = target; } mute() {} destroy() {}
  } };
  const owner = new OfficialPlayer({ replaceChildren() {}, append() {} }, () => {}, {
    viewer: true, muted: true, delayWait: async () => { edge += 1.5; time += 1.5; }
  });
  try {
    await owner.select({ video_id: 'test-video' }); events.onReady(); events.onStateChange({ data: 1 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(seeks.length, 1); assert.equal(owner.delayStatus.state, 'applied');
    events.onStateChange({ data: 2 }); assert.equal(owner.delayStatus.state, 'idle');
  } finally { owner.dispose(); Object.assign(globalThis, previous); }
});
