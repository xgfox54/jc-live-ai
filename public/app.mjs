import { TranscriptState } from './client-state.mjs';
import { subscribe } from './subscription.mjs';
import { toggleSelection } from './selection.mjs';
import { ViewerStage } from './viewer-stage.mjs';
import { pollSnapshots } from './polling.mjs';
import './display.mjs';
import { committees, CHANNEL_IDS, committeeForChannel } from './committees.mjs';

const $ = selector => document.querySelector(selector);
const ids = CHANNEL_IDS;
const state = new TranscriptState();
const choices = new Map(); const stages = new Map();
const withCommittees = values => committees.map(committee => ({ page_url: '', video_id: null,
  ...values.find(stream => stream.stream_id === committee.stream_id), stream_id: committee.stream_id, name: committee.name }));
let streams = withCommittees([]); let selected = []; let subscription; let before = {};
let delivery; let loaded = false; let schedule = null;
const message = value => { $('#notice').textContent = value; };
const seoulToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.now());
const dayLabel = date => {
  const [year, month, day] = date.split('-').map(Number);
  return month + '월 ' + day + '일(' + '일월화수목금토'[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] + ')';
};
const upcoming = () => (schedule?.items ?? []).filter(item => item.date >= seoulToday());
async function api(path, options = {}) {
  const response = await fetch(path.replace('/api/', '/api/viewer/'), options);
  if (!response.ok) throw new Error('방송 정보를 불러오지 못했습니다. 다시 연결해 주세요.');
  return response;
}
for (const [index, id] of ids.entries()) {
  const choice = document.createElement('button'); choice.className = 'channel-choice'; choice.disabled = true;
  choice.setAttribute('aria-pressed', 'false');
  const number = document.createElement('span'); number.className = 'channel-number'; number.textContent = String(index + 1).padStart(2, '0');
  const name = document.createElement('strong'); const status = document.createElement('span'); status.className = 'channel-status';
  choice.append(number, name, status); $('#channels').append(choice); choices.set(id, { choice, name, status });
  choice.addEventListener('click', () => {
    const result = toggleSelection(selected, id, streams.map(stream => stream.stream_id));
    if (result.limited) { message('동시 시청은 2개까지 가능합니다. 선택한 방송 하나를 먼저 해제해 주세요.'); return; }
    selected = result.ids; message(''); reconcile(); renderChoices();
  });
}
function renderChoices() {
  const names = { running: '전사 중', draining: '전사 마무리 중', stopped: '기록 종료',
    degraded: '전사 지연', interrupted: '전사 중단', reconnecting: '재연결 중' };
  for (const id of ids) {
    const { choice, name, status } = choices.get(id); const stream = streams.find(item => item.stream_id === id);
    const chosen = selected.includes(id);
    choice.disabled = !stream; choice.setAttribute('aria-pressed', String(chosen));
    name.textContent = committeeForChannel(id).name;
    const next = upcoming().find(item => item.stream_id === id);
    const planned = next && (next.status === 'live' ? '방송 중 · ' : '방송 예정 · ') + dayLabel(next.date) + ' ' + next.time;
    const current = state.status.get(id)?.state; const active = ['running', 'draining', 'degraded', 'reconnecting'].includes(current);
    status.textContent = (chosen ? '✓ 시청 선택 · ' : '') + ((active ? names[current] : planned ?? names[current])
      ?? (stream?.page_url ? '방송 주소 등록됨' : '방송 전 · 수신 대기'));
  }
  $('#selection-count').textContent = selected.length + ' / 2 선택';
  if (loaded) {
    const available = streams.some(stream => stream.page_url && !['stopped', 'interrupted'].includes(state.status.get(stream.stream_id)?.state));
    $('#empty-view h2').textContent = available ? '시청할 방송을 선택해 주세요' : '현재 진행중인 방송 채널이 없습니다.';
    $('#empty-view p').hidden = !available;
  }
}
function renderSchedule() {
  const items = upcoming(); const days = new Map();
  for (const item of items) days.set(item.date, [...(days.get(item.date) ?? []), item]);
  $('#schedule').hidden = !items.length;
  $('#schedule-list').replaceChildren(...[...days].map(([date, list]) => {
    const day = document.createElement('section'); day.className = 'schedule-day';
    const heading = document.createElement('h3'); heading.textContent = dayLabel(date) + (date === seoulToday() ? ' 오늘' : '');
    const rows = document.createElement('ul');
    for (const item of list) {
      const row = document.createElement('li'); row.className = 'schedule-item';
      const time = document.createElement('time'); time.dateTime = item.starts_at; time.textContent = item.time;
      const title = document.createElement('span'); title.className = 'schedule-title'; title.textContent = item.title;
      const channel = document.createElement('span'); channel.className = 'schedule-channel';
      const committee = item.stream_id && committeeForChannel(item.stream_id);
      channel.textContent = (item.status === 'live' ? '방송 중 · ' : '') + (committee ? String(ids.indexOf(item.stream_id) + 1).padStart(2, '0') + ' ' + committee.name + ' 채널' : '위원회 채널 외 방송');
      row.append(time, title, channel); rows.append(row);
    }
    day.append(heading, rows); return day;
  }));
}
async function loadSchedule() {
  try { schedule = await (await api('/api/schedule')).json(); } catch { return; }
  renderSchedule(); renderChoices();
}
function reconcile() {
  selected = selected.filter(id => streams.some(stream => stream.stream_id === id));
  for (const [id, stage] of stages) if (!selected.includes(id)) { stage.dispose(); stages.delete(id); }
  for (const id of selected) {
    const stream = streams.find(item => item.stream_id === id);
    if (!stages.has(id)) {
      const stage = new ViewerStage({ stream, api, state, message, before: before[id],
        close: () => { selected = selected.filter(value => value !== id); reconcile(); renderChoices(); choices.get(id).choice.focus(); },
        sound: () => { for (const [otherId, other] of stages) if (otherId !== id) other.setMuted(true); } });
      stages.set(id, stage); $('#watch-grid').append(stage.element);
    } else stages.get(id).update(stream);
    stages.get(id).render();
  }
  $('#watch-grid').classList.toggle('dual', selected.length === 2);
  $('#empty-view').hidden = selected.length > 0;
}
async function refresh() {
  const snapshot = await (await api('/api/snapshot')).json();
  streams = withCommittees(snapshot.streams); before = snapshot.before; delivery = snapshot.delivery; state.reset(snapshot); loaded = true;
  for (const [id, stage] of stages) stage.before = before[id] ?? Number.MAX_SAFE_INTEGER;
  reconcile(); renderChoices();
}
async function connect() {
  subscription?.abort(); subscription = new AbortController();
  $('#retry').hidden = true; $('#connection').textContent = '연결 중';
  try {
    await refresh(); message('');
    if (delivery?.mode === 'poll') {
      const showConnection = ok => {
        $('#connection').textContent = !ok ? '새 자료 수신이 지연되고 있습니다'
          : '최근 갱신 ' + new Date(delivery.published_ms).toLocaleTimeString('ko-KR');
      };
      showConnection(true);
      pollSnapshots({ refresh, signal: subscription.signal, interval: delivery.interval_ms, connection: showConnection });
      return;
    }
    subscribe({ api, state, ids, signal: subscription.signal, refresh,
      changed: event => {
        if (event.kind === 'stream') {
          const previous = streams.find(stream => stream.stream_id === event.payload.stream_id);
          if (event.payload.deleted || previous?.broadcast_id !== event.payload.broadcast_id) {
            for (const item of [...state.segments.values()]) if (item.stream_id === event.payload.stream_id) state.segments.delete(item.segment_id);
            state.gaps.delete(event.payload.stream_id); state.status.delete(event.payload.stream_id);
            before[event.payload.stream_id] = Number.MAX_SAFE_INTEGER;
            const stage = stages.get(event.payload.stream_id); if (stage) stage.before = Number.MAX_SAFE_INTEGER;
          }
          streams = streams.filter(stream => stream.stream_id !== event.payload.stream_id);
          if (!event.payload.deleted) streams.push(event.payload); streams = withCommittees(streams); reconcile();
        } else if (event.kind === 'segment' || event.kind === 'gap' || event.kind === 'partial' || event.kind === 'session') stages.get(event.payload.stream_id)?.render();
        renderChoices();
      },
      connection: value => { $('#connection').textContent = value === '연결됨' ? '' : '다시 연결하는 중입니다'; }
    }).catch(() => { message('연결이 끊겼습니다. 다시 연결해 주세요.'); $('#retry').hidden = false; });
  } catch (error) { message(error.message); $('#connection').textContent = '연결하지 못했습니다'; $('#retry').hidden = false; }
}
$('#retry').addEventListener('click', connect);
setInterval(loadSchedule, 600_000);
window.addEventListener('pagehide', () => { subscription?.abort(); for (const stage of stages.values()) stage.dispose(); stages.clear(); });
window.addEventListener('pageshow', event => { if (event.persisted) connect(); });
renderChoices(); connect(); loadSchedule();
