import { TranscriptState } from './client-state.mjs';
import { subscribe } from './subscription.mjs';
import { toggleSelection } from './selection.mjs';
import { ViewerStage } from './viewer-stage.mjs';

const $ = selector => document.querySelector(selector);
const ids = Array.from({ length: 8 }, (_, index) => 'ch' + (index + 1));
const state = new TranscriptState();
const choices = new Map(); const stages = new Map();
let streams = []; let selected = []; let subscription; let before = {};
const message = value => { $('#notice').textContent = value; };
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
  const names = { running: '전사 중', draining: '전사 마무리 중', stopped: '전사 종료',
    degraded: '전사 지연', interrupted: '전사 중단', reconnecting: '재연결 중' };
  for (const id of ids) {
    const { choice, name, status } = choices.get(id); const stream = streams.find(item => item.stream_id === id);
    const chosen = selected.includes(id);
    choice.disabled = !stream; choice.setAttribute('aria-pressed', String(chosen));
    name.textContent = stream?.name ?? '등록된 방송 없음';
    status.textContent = (chosen ? '✓ 시청 선택 · ' : '') + (stream ? names[state.status.get(id)?.state] ?? '시청 가능' : '준비 중');
  }
  $('#selection-count').textContent = selected.length + ' / 2 선택';
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
  streams = snapshot.streams; before = snapshot.before; state.reset(snapshot);
  for (const [id, stage] of stages) stage.before = before[id] ?? Number.MAX_SAFE_INTEGER;
  reconcile(); renderChoices();
  $('#empty-view p').textContent = streams.length ? '선택한 영상과 전사문이 이곳에 표시됩니다.' : '아직 등록된 방송이 없습니다.';
}
async function connect() {
  subscription?.abort(); subscription = new AbortController();
  $('#retry').hidden = true; $('#connection').textContent = '연결 중';
  try {
    await refresh(); message('');
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
          if (!event.payload.deleted) streams.push(event.payload); reconcile();
        } else if (event.kind === 'segment' || event.kind === 'gap') stages.get(event.payload.stream_id)?.render();
        renderChoices();
      },
      connection: value => { $('#connection').textContent = value === '연결됨' ? '실시간 연결됨' : '다시 연결하는 중입니다'; }
    }).catch(() => { message('연결이 끊겼습니다. 다시 연결해 주세요.'); $('#retry').hidden = false; });
  } catch (error) { message(error.message); $('#connection').textContent = '연결하지 못했습니다'; $('#retry').hidden = false; }
}
$('#retry').addEventListener('click', connect);
window.addEventListener('pagehide', () => { subscription?.abort(); for (const stage of stages.values()) stage.dispose(); stages.clear(); });
window.addEventListener('pageshow', event => { if (event.persisted) connect(); });
renderChoices(); connect();
