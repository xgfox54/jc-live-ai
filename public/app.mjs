import { TranscriptState } from './client-state.mjs';
import { subscribe } from './subscription.mjs';
import { startCapture, stopCapture, captureCount } from './capture.mjs';
import { OfficialPlayer, visibleAt } from './player.mjs';

const $ = selector => document.querySelector(selector);
const state = new TranscriptState(); const ids = Array.from({ length: 8 }, (_, i) => 'ch' + (i + 1));
let token = ''; let streams = []; let selected = 'ch1'; let subscription;
const panels = new Map(); const history = new Map();
const message = value => { $('#notice').textContent = value; };
const player = new OfficialPlayer($('#player'), value => { $('#sync-status').textContent = value; });
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { Authorization: 'Bearer ' + token, ...options.headers } });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'HTTP ' + response.status }));
    throw new Error(error.error);
  }
  return response;
}
function button(label, action) {
  const node = document.createElement('button'); node.textContent = label; node.className = 'secondary';
  node.addEventListener('click', () => Promise.resolve(action()).catch(error => message(error.message))); return node;
}
function select(id) {
  selected = id;
  const stream = streams.find(item => item.stream_id === id);
  $('#selected-name').textContent = stream?.name ?? id;
  $('#source-link').hidden = !stream?.page_url;
  if (stream?.page_url) $('#source-link').href = stream.page_url;
  if (stream) player.select(stream).catch(error => message(error.message));
  render();
}
for (const id of ids) {
  const panel = document.createElement('article'); panel.className = 'channel';
  const head = document.createElement('div'); head.className = 'channel-head';
  const title = document.createElement('h2'); const choose = button(id + ' · 미등록', () => select(id)); title.append(choose);
  const meta = document.createElement('div'); meta.className = 'channel-meta';
  const transcript = document.createElement('div'); transcript.className = 'transcript'; transcript.tabIndex = 0;
  transcript.setAttribute('aria-label', id + ' 전사문');
  const footer = document.createElement('div'); footer.className = 'channel-footer';
  footer.append(button('이전 문장', async () => {
    const before = history.get(id) ?? Number.MAX_SAFE_INTEGER;
    const page = await (await api('/api/segments?stream=' + id + '&before=' + before)).json();
    if (!page.items.length) { message('이전 문장이 더 없습니다.'); return; }
    history.set(id, page.before ?? before);
    for (const segment of [...state.segments.values()]) if (segment.stream_id === id) state.segments.delete(segment.segment_id);
    for (const segment of page.items) state.put(segment);
    $('#autoscroll').checked = false; render();
  }));
  head.append(title, meta); panel.append(head, transcript, footer); $('#channels').append(panel);
  panels.set(id, { panel, choose, meta, transcript });
}
const stateNames = { running: '수집 중', draining: '남은 음성 처리 중', stopped: '중지',
  degraded: '처리 지연', interrupted: '중단됨', reconnecting: '재연결 중' };
function render() {
  const search = $('#search').value.trim().toLocaleLowerCase();
  const synchronized = $('#synced').checked;
  const clock = player.clock(state.status.get(selected));
  for (const id of ids) {
    const panel = panels.get(id); const stream = streams.find(s => s.stream_id === id);
    const status = state.status.get(id); const gap = state.gaps.get(id);
    const inputStale = status && ['running','degraded'].includes(status.state)
      && Date.now() - (status.last_receive_ms ?? status.started_ms) > 10000;
    panel.panel.classList.toggle('selected', selected === id);
    panel.choose.textContent = stream?.name ?? id + ' · 미등록';
    panel.meta.textContent = status
      ? (stateNames[status.state] ?? status.state) + ' · 대기 ' + status.queue_length + '개 · 수신 '
        + (status.audio_received_until / 1000).toFixed(0) + '초 / 처리 ' + (status.audio_processed_until / 1000).toFixed(0)
        + '초' + (inputStale ? ' · 입력 확인 필요' : '') + (gap ? ' · 누락 기록 있음' : '')
        + (status.error ? ' · ' + status.error : '')
      : '방송 링크를 등록한 뒤 수집 시작을 눌러 주세요.';
    const items = [...state.segments.values()].filter(s => s.stream_id === id
      && (!search || (s.corrected_text ?? s.raw_text).toLocaleLowerCase().includes(search))
      && (!synchronized || id !== selected || visibleAt(s, clock))).slice(-200);
    const fragment = document.createDocumentFragment();
    if (!items.length) {
      const empty = document.createElement('p'); empty.className = 'empty';
      empty.textContent = synchronized && id === selected && !clock
        ? '음성·영상 시간 연결을 확인한 뒤 표시합니다. 최신 전사문은 영상 시점 표시를 해제해 확인하세요.'
        : '아직 표시할 전사문이 없습니다.';
      fragment.append(empty);
    }
    for (const item of items) {
      const line = document.createElement('div'); line.className = 'segment';
      const meta = document.createElement('small');
      meta.textContent = (item.start_ms / 1000).toFixed(1) + '–' + (item.end_ms / 1000).toFixed(1)
        + '초 · ' + (item.corrected_text === null ? '원문' : '검토문') + ' · v' + item.version;
      const content = document.createElement('span'); content.textContent = item.corrected_text ?? item.raw_text;
      line.append(meta, content, button('문장 정보', () => message('ID: ' + item.segment_id + ' / 버전: ' + item.version)));
      if (clock && id === selected) line.append(button('해당 시점 재생', () => player.seek(item)));
      fragment.append(line);
    }
    const top = panel.transcript.scrollTop; panel.transcript.replaceChildren(fragment);
    panel.transcript.scrollTop = $('#autoscroll').checked ? panel.transcript.scrollHeight : top;
  }
}
async function refresh() {
  const snapshot = await (await api('/api/snapshot')).json();
  streams = snapshot.streams; state.reset(snapshot); history.clear();
  for (const [id, before] of Object.entries(snapshot.before ?? {})) if (before) history.set(id, before);
  render();
}
$('#login').addEventListener('submit', async event => {
  event.preventDefault();
  if (captureCount()) { message('수집을 중지한 뒤 접근키를 변경해 주세요.'); return; }
  token = $('#token').value; $('#token').value = '';
  subscription?.abort(); subscription = new AbortController();
  try {
    await refresh();
    subscribe({ api, state, ids, signal: subscription.signal, refresh, changed: () => render(),
      connection: value => { $('#connection').textContent = value; } }).catch(error => message(error.message));
    message('연결했습니다. 접근키는 이 화면의 메모리에만 보관합니다.');
  } catch (error) { message(error.message); }
});
$('#register').addEventListener('submit', async event => {
  event.preventDefault(); const data = Object.fromEntries(new FormData(event.target));
  try {
    await api('/api/admin/streams', { method: 'POST', body: JSON.stringify({ ...data, approved: data.approved === 'on' }) });
    await refresh(); message('방송을 등록했습니다. 수집 시작을 눌러 주세요. 탭 공유 방식은 공식 영상을 먼저 재생해야 합니다.');
  } catch (error) { message(error.message); }
});
$('#capture').addEventListener('click', async () => {
  try {
    const id = $('#manage-channel').value; const stream = streams.find(s => s.stream_id === id);
    if (['youtube', 'file', 'council'].includes(stream?.kind)) {
      await api('/api/admin/streams/' + id + '/start', { method: 'POST' }); message('음원 수신을 시작합니다. 방송별 입력 상태를 확인해 주세요.');
    } else await startCapture(id, api, message);
  }
  catch (error) { message(error.message); }
});
$('#stop').addEventListener('click', async () => {
  try {
    const id = $('#manage-channel').value; const stream = streams.find(s => s.stream_id === id);
    if (['youtube', 'file', 'council'].includes(stream?.kind)) await api('/api/admin/streams/' + id + '/stop', { method: 'POST' });
    else await stopCapture(id, api);
    message('수집을 중지하고 받은 음성을 처리합니다.');
  }
  catch (error) { message(error.message); }
});
$('#correct').addEventListener('submit', async event => {
  event.preventDefault(); const data = Object.fromEntries(new FormData(event.target));
  try {
    await api('/api/admin/segments/' + encodeURIComponent(data.id),
      { method: 'POST', body: JSON.stringify({ version: Number(data.version), text: data.text }) });
    message('원문을 유지하고 검토문을 저장했습니다.');
  } catch (error) { message(error.message); }
});
$('#sync-form').addEventListener('submit', async event => {
  event.preventDefault(); const status = state.status.get(selected);
  if (!status) { message('먼저 방송을 수집해 주세요.'); return; }
  const data = Object.fromEntries(new FormData(event.target));
  try {
    await player.probe({ audioMs: Number(data.audio) * 1000, playerSeconds: Number(data.video), liveEdge: Number(data.edge),
      session: status.session_id, epoch: status.timeline_epoch }); render();
  } catch (error) { message(error.message); }
});
$('#search').addEventListener('input', render); $('#synced').addEventListener('change', render);
setInterval(() => { if (token) render(); }, 1000);
window.addEventListener('beforeunload', event => { if (captureCount()) { event.preventDefault(); event.returnValue = ''; } });
render();
