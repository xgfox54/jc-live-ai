import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatElapsedTime, formatReceivedTime, transcriptNodes } from '../public/transcripts.mjs';

test('elapsed transcript time floors fractional seconds and preserves total hours', () => {
  for (const [milliseconds, expected] of [
    [0, '00시간 00분 00초'],
    [999, '00시간 00분 00초'],
    [59999, '00시간 00분 59초'],
    [60000, '00시간 01분 00초'],
    [3599999, '00시간 59분 59초'],
    [3600000, '01시간 00분 00초'],
    [4118400, '01시간 08분 38초'],
    [86400000, '24시간 00분 00초'],
    [360000000, '100시간 00분 00초'],
  ]) assert.equal(formatElapsedTime(milliseconds), expected);
});

test('invalid transcript times remain unknown rather than becoming zero', () => {
  for (const value of [null, undefined, NaN, Infinity, -Infinity, -1, '4118400', {}, false])
    assert.equal(formatElapsedTime(value), '시간 미확인');
});

test('viewer and admin transcript ranges retain text, source times and audio callbacks', t => {
  const previous = globalThis.document;
  const node = tag => ({ tag, children: [], listeners: {}, append(...children) { this.children.push(...children); },
    addEventListener(name, callback) { this.listeners[name] = callback; } });
  globalThis.document = { createElement: node, createDocumentFragment: () => node('fragment') };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const item = Object.freeze({ segment_id: 'time-example', start_ms: 4118400, end_ms: 4123999,
    ai_corrected: true, text: '공개 검토문', raw_text: '원문', corrected_text: '관리자 검토문' });
  const viewer = transcriptNodes([item], { publicOnly: true }).children[0];
  assert.equal(viewer.children[0].textContent, '수신 시각 미확인 · 영상 시간 01시간 08분 38초 ~ 01시간 08분 43초 · AI 후보정');
  assert.equal(viewer.children[1].textContent, item.text);
  let played;
  const admin = transcriptNodes([item], { mode: 'both', audio: value => { played = value; } }).children[0];
  assert.equal(admin.children[0].textContent, '01시간 08분 38초 ~ 01시간 08분 43초 · 검토문');
  assert.equal(admin.children[1].textContent, item.corrected_text);
  assert.equal(admin.children[2].textContent, '원문: 원문');
  admin.children[3].listeners.click();
  assert.equal(played, item);
  assert.equal(played.start_ms, 4118400);
  assert.equal(played.end_ms, 4123999);
});

test('receive clock survives session resets and never guesses a video position', () => {
  assert.equal(formatReceivedTime(1792740568262), '2026.10.23 16시 29분 28초');
  assert.equal(formatReceivedTime(Date.parse('2026-10-23T15:00:00Z')), '2026.10.24 00시 00분 00초');
  for (const value of [null, undefined, NaN, Infinity, 0, -1, 1.1, '1792740568262', 8640000000000001])
    assert.equal(formatReceivedTime(value), '시각 미확인');
});

test('web deployment transcript module matches the local viewer module', () => {
  assert.equal(readFileSync(new URL('../web/public/transcripts.mjs', import.meta.url), 'utf8'),
    readFileSync(new URL('../public/transcripts.mjs', import.meta.url), 'utf8'));
});
