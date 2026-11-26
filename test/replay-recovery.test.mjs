import test from 'node:test';
import assert from 'node:assert/strict';
import { missingRanges, speechClusters, stretchPlacement, recessCuts, announcedResume, wallClock } from '../src/replay-recovery.mjs';
import { airTimes } from '../src/broadcast-registry.mjs';

const at = text => Date.parse('2026-11-26T' + text + ':00+09:00');

test('missing replay parts leave out covered time and parts under 20 seconds', () => {
  assert.deepEqual(missingRanges(600_000, [[0, 100_000], [110_000, 300_000], [290_000, 400_000]]), [[400_000, 600_000]]);
  assert.deepEqual(missingRanges(600_000, []), [[0, 600_000]]);
  assert.deepEqual(missingRanges(600_000, [[-5_000, 700_000]]), []);
});

test('speech after an hour of recess forms its own stretch', () => {
  const rows = [{ start_ms: 3_600_000, end_ms: 3_608_000 }, { start_ms: 10_000, end_ms: 18_000 }, { start_ms: 3_650_000, end_ms: 3_700_000 }, { start_ms: 20_000, end_ms: 25_000 }];
  assert.deepEqual(speechClusters(rows), [{ from_ms: 10_000, to_ms: 25_000 }, { from_ms: 3_600_000, to_ms: 3_700_000 }]);
});

test('a stretch is placed by agreeing probes and covered from the first to the last of them', () => {
  const probe = (probe_ms, shift_ms, status = 'matched') => ({ status, probe_ms, shift_ms });
  // 4차 보건복지안전위원회 of 26 November: the first probe fell on remarks the replay leaves out.
  assert.deepEqual(stretchPlacement([probe(1_260_000, null, 'ambiguous'), probe(1_290_000, -1_224_756), probe(1_320_000, -1_224_756),
    probe(1_350_000, -1_224_756), probe(1_380_000, -1_224_740)]), { shift_ms: -1_224_756, from_ms: 1_290_000, to_ms: 1_410_000 });
  assert.equal(stretchPlacement([probe(0, 12_040)]).shift_ms, 12_040);
  assert.equal(stretchPlacement([probe(0, 12_040), probe(10_000, 40_000)]), null);
  assert.equal(stretchPlacement([probe(0, 12_040), probe(10_000, null, 'ambiguous'), probe(20_000, null, 'ambiguous')]), null);
  assert.equal(stretchPlacement([probe(0, null, 'silent')]), null);
});

// 4차 문화관광체육위원회 of 26 November: the replay runs straight from the 14:02 recess into the evening resumption.
test('a recess cut out of the replay is found where the resumption follows the declaration', () => {
  const rows = [
    { start_ms: 136_660, end_ms: 145_000, raw_text: '계수조정을 위해' },
    { start_ms: 145_000, end_ms: 153_000, raw_text: '18시까지 정회토록 하겠습니다. 정회를 선포합니다.' },
    { start_ms: 153_000, end_ms: 162_000, raw_text: '의석을 정돈해 주시기 바랍니다. 회의를 속개하겠습니다.' }];
  assert.deepEqual(recessCuts(rows).map(cut => cut.at_ms), [153_000]);
  // A replay that keeps the recess has its silence between the two, so nothing is cut.
  assert.deepEqual(recessCuts([rows[1], { ...rows[2], start_ms: 900_000, end_ms: 909_000 }]), []);
  assert.deepEqual(recessCuts([{ start_ms: 0, end_ms: 9000, raw_text: '정회를 선포합니다. 의석을 정돈해 주십시오. 속개하겠습니다.' }]).map(cut => cut.at_ms), [4500]);
});

test('the announced resumption is read as a clock time or a length', () => {
  assert.equal(announcedResume('18시까지 정회토록 하겠습니다.', '2026-11-26', at('16:30')), at('18:00'));
  assert.equal(announcedResume('오후 3시 30분까지 정회하겠습니다.', '2026-11-26', at('14:50')), at('15:30'));
  assert.equal(announcedResume('10분간 정회를 선포합니다.', '2026-11-26', at('15:00')), at('15:10'));
  assert.equal(announcedResume('정회를 선포합니다.', '2026-11-26', at('15:00')), null);
});

test('each piece of a recovered part takes its own wall time', () => {
  const cuts = [{ at_ms: 153_000, text: '18시까지 정회토록 하겠습니다.' }];
  const ended = wallClock({ length_ms: 267_000, cuts, start_ms: at('14:00'), end_ms: at('18:11'), date: '2026-11-26' });
  assert.deepEqual(ended.map(piece => [piece.wall_ms, piece.basis]), [[at('14:00'), 'start'], [at('18:11') - 114_000, 'end']]);
  assert.deepEqual(wallClock({ length_ms: 267_000, cuts, start_ms: at('14:00'), date: '2026-11-26' }).map(piece => piece.basis), ['start', 'announced']);
  const marked = wallClock({ length_ms: 267_000, cuts, start_ms: at('14:00'), end_ms: at('18:11'),
    spans: [{ from_ms: at('14:03'), to_ms: at('18:08') }] });
  assert.deepEqual(marked.map(piece => [piece.wall_ms, piece.basis]), [[at('14:00'), 'start'], [at('18:08'), 'recess-mark']]);
  // Without a cut, an end four hours away from the start estimate is not trusted.
  assert.equal(wallClock({ length_ms: 60_000, start_ms: at('14:00'), end_ms: at('18:00') })[0].basis, 'start');
  assert.equal(wallClock({ length_ms: 60_000, start_ms: at('14:00'), end_ms: at('14:05') })[0].wall_ms, at('14:04'));
});

test('the official list marks are kept as air and recess times', () => {
  let record = { phase: 'waiting', ...airTimes(null, { phase: 'waiting', recess: false }, at('13:55')) };
  record = { ...record, phase: 'live', ...airTimes(record, { phase: 'live', recess: false }, at('14:00')) };
  record = { ...record, recess: true, phase: 'waiting', ...airTimes(record, { phase: 'waiting', recess: true }, at('14:03')) };
  record = { ...record, recess: false, phase: 'live', ...airTimes(record, { phase: 'live', recess: false }, at('18:08')) };
  record = { ...record, ...airTimes(record, { phase: 'offline' }, at('18:11')) };
  assert.deepEqual({ from: record.aired_from_ms, until: record.aired_until_ms, spans: record.recess_spans },
    { from: at('14:00'), until: at('18:11'), spans: [{ from_ms: at('14:03'), to_ms: at('18:08') }] });
});
