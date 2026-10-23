import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBroadcastSchedule, CouncilSchedule, SCHEDULE_URL } from '../src/council-schedule.mjs';
import { publicSnapshot } from '../web/lib/model.mjs';

const row = (label, time, title) => '<tr><th><i class="off">' + label + '</i></th><td>[' + time + ']\n' + title
  + '<a href="#" class="btn">안건확인</a><div class="s-box"><dl><dt>▣ ' + title + '(' + time + ')<br />1. 안건</dt></dl></div></td></tr>';
const day = (date, rows) => '<table class="s-list"><thead><tr><th colspan="2">' + date + '</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>';
const page = tables => '<html><body><h2>생방송 일정</h2>' + tables.join('') + '</body></html>';
const october = page([day('2026-10-23', [row('방송예정', '14:00', '2차 본회의')]),
  day('2026-10-21', [row('방송예정', '15:00', '2차 교육위원회'), row('방송중', '10:00', '2차 행정자치위원회')]),
  day('2026-10-20', [row('방송종료', '10:00', '1차 행정자치위원회')])]);

test('official live schedule maps date, Seoul time, status and committee channel', () => {
  const items = parseBroadcastSchedule(october);
  assert.deepEqual(items.map(item => [item.starts_at, item.status, item.stream_id]), [
    ['2026-10-20T10:00:00+09:00', 'ended', 'ch2'], ['2026-10-21T10:00:00+09:00', 'live', 'ch2'],
    ['2026-10-21T15:00:00+09:00', 'scheduled', 'ch8'], ['2026-10-23T14:00:00+09:00', 'scheduled', 'ch0']]);
  assert.equal(items[2].title, '2차 교육위원회');
  assert.deepEqual(parseBroadcastSchedule(page([])), []);
  assert.throws(() => parseBroadcastSchedule('<html>차단</html>'), /형식/);
});
test('schedule reads this and next month in Seoul time and publishes only upcoming meetings', async () => {
  const requested = [];
  const schedule = new CouncilSchedule({ now: () => Date.parse('2026-12-20T16:00:00Z'),
    fetchHtml: async url => { requested.push(url); return url.endsWith('month=12') ? october : page([]); } });
  await schedule.refresh();
  assert.deepEqual(requested, [SCHEDULE_URL + '?year=2026&month=12', SCHEDULE_URL + '?year=2027&month=1']);
  assert.equal(schedule.view().items.length, 0);
  const current = new CouncilSchedule({ now: () => Date.parse('2026-10-21T00:30:00Z'), fetchHtml: async () => october });
  await current.refresh();
  const view = current.view();
  assert.deepEqual(view.items.map(item => item.title), ['2차 행정자치위원회', '2차 교육위원회', '2차 본회의']);
  const published = publicSnapshot({ event_id: 0, streams: [], segments: [], states: [], gaps: [], schedule: view });
  assert.deepEqual(published.schedule.items, view.items);
  assert.throws(() => publicSnapshot({ event_id: 0, streams: [], segments: [], states: [], gaps: [],
    schedule: { ...view, source_url: 'https://example.com/' } }));
  const failing = new CouncilSchedule({ fetchHtml: async () => { throw new Error('offline'); } });
  failing.items = view.items; await failing.refresh();
  assert.equal(failing.adminView().phase, 'retry'); assert.equal(failing.items.length, 3);
});
