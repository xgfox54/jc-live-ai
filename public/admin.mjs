import { TranscriptState } from './client-state.mjs';
import { subscribe } from './subscription.mjs';
import { startCapture, stopCapture, captureCount } from './capture.mjs';
import { AdminTools } from './admin-tools.mjs';

const $ = selector => document.querySelector(selector);
const ids = Array.from({ length: 8 }, (_, i) => 'ch' + (i + 1));
const state = new TranscriptState(); let streams = []; let token = ''; let subscription;
let monitoring = []; let monitorTimer;
const autoSupported = stream => ['youtube', 'council'].includes(stream?.kind);
const message = value => { $('#notice').textContent = value; };
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json',
    Authorization: 'Bearer ' + token, ...options.headers } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) throw new Error('관리자 접근키를 확인해 주세요.');
    throw new Error(body.error ?? '요청을 처리하지 못했습니다.');
  }
  return response;
}
for (const selector of ['#register-channel', '#manage-channel', '#review-channel', '#sync-channel']) {
  for (const [index, id] of ids.entries()) {
    const option = document.createElement('option'); option.value = id; option.textContent = '방송 ' + (index + 1); $(selector).append(option);
  }
}
const tools = new AdminTools({ api, state, message, streams: () => streams, refresh: () => refresh() });
const cards = new Map();
for (const [index, id] of ids.entries()) {
  const card = document.createElement('button'); card.className = 'admin-channel secondary';
  const title = document.createElement('strong'); const status = document.createElement('span'); card.append(title, status);
  card.addEventListener('click', () => { fillStream(id); $('#register-channel').focus(); });
  $('#admin-list').append(card); cards.set(id, { card, title, status, number: index + 1 });
}
function fillStream(id) {
  const form = $('#register'); form.reset(); form.elements.stream_id.value = id; $('#manage-channel').value = id;
  const stream = streams.find(item => item.stream_id === id);
  if (stream) for (const name of ['name', 'kind', 'page_url', 'approval_note', 'prompt']) form.elements[name].value = stream[name] ?? '';
  form.elements.approved.checked = stream?.approved === true;
  form.elements.auto_start.checked = stream ? autoSupported(stream) && stream.auto_start !== false : true;
  updateAutoInput(); render();
}
function updateAutoInput() {
  const input = $('#auto-start'); input.disabled = !autoSupported({ kind: $('#register').elements.kind.value });
}
function renderMonitor() {
  const id = $('#manage-channel').value; const stream = streams.find(item => item.stream_id === id);
  const status = monitoring.find(item => item.stream_id === id);
  const enabled = autoSupported(stream) && stream.auto_start !== false;
  $('#auto-toggle').disabled = !autoSupported(stream);
  $('#auto-toggle').textContent = enabled ? '자동 감지 끄기' : '자동 감지 켜기';
  const names = { waiting: '방송 시작 대기', checking: '방송 상태 확인 중', live: '생방송 감지',
    collecting: '녹음·전사 중', ended: '방송 종료', completed: '이 방송의 수집 완료', offline: '생방송 아님',
    retry: '조회·수집 재시도 대기', disabled: '자동 감지 꺼짐', blocked: '자동 감지 중단' };
  $('#auto-status').textContent = !stream ? '방송을 먼저 등록해 주세요.' : !autoSupported(stream) ? '이 입력 방식은 수동으로 시작합니다.'
    : (names[status?.phase] ?? (enabled ? '방송 시작 대기' : '자동 감지 꺼짐'))
    + (status?.checked_ms ? ' · 최근 확인 ' + new Date(status.checked_ms).toLocaleTimeString('ko-KR') : '')
    + (status?.error ? ' · ' + status.error : '');
}
function render() {
  const names = { running: '수집 중', draining: '처리 중', stopped: '중지', degraded: '처리 지연', interrupted: '중단' };
  for (const [id, item] of cards) {
    const stream = streams.find(value => value.stream_id === id); const status = state.status.get(id);
    item.title.textContent = item.number + '. ' + (stream?.name ?? '미등록');
    item.card.setAttribute('aria-pressed', String($('#register-channel').value === id));
    item.status.textContent = status ? (names[status.state] ?? status.state) + ' · 대기 ' + status.queue_length + '개'
      + (status.error ? ' · ' + status.error : '') : stream ? '등록됨' : '영상 주소를 등록해 주세요.';
    for (const selector of ['#manage-channel', '#review-channel', '#sync-channel']) {
      $(selector).querySelector('option[value="' + id + '"]').textContent = item.number + '. ' + (stream?.name ?? '미등록');
    }
  }
  const active = state.status.get($('#manage-channel').value);
  $('#metrics-note').textContent = active ? '수신 ' + (active.total_received_s ?? 0).toFixed(1) + '초 · 처리 '
    + (active.total_processed_s ?? 0).toFixed(1) + '초 · 누락 ' + (active.total_gap_s ?? 0).toFixed(1) + '초' : '수집 이력이 없습니다.';
  const busy = [...state.status.values()].some(value => ['running', 'draining', 'degraded'].includes(value.state));
  $('#settings-form button').disabled = busy;
  renderMonitor();
}
async function refresh() {
  const [catalog, snapshot] = await Promise.all([
    api('/api/admin/streams').then(response => response.json()), api('/api/snapshot').then(response => response.json())
  ]);
  streams = catalog.streams; monitoring = catalog.monitoring ?? []; state.reset({ ...snapshot, states: catalog.states }); render(); tools.renderReview();
}
$('#login').addEventListener('submit', async event => {
  event.preventDefault(); token = $('#token').value; $('#token').value = '';
  const submit = $('#login button'); submit.disabled = true;
  try {
    await refresh(); tools.showSettings(await (await api('/api/admin/settings')).json());
    subscription?.abort(); subscription = new AbortController();
    $('#auth').hidden = true; $('#workspace').hidden = false; $('#logout').hidden = false; message('관리자로 연결했습니다.');
    fillStream($('#register-channel').value);
    clearInterval(monitorTimer);
    monitorTimer = setInterval(async () => {
      const sessionToken = token;
      if (!sessionToken) return;
      try {
        const catalog = await (await api('/api/admin/streams')).json();
        if (token !== sessionToken) return;
        streams = catalog.streams; monitoring = catalog.monitoring ?? []; renderMonitor();
      } catch (error) { if (token === sessionToken) $('#auto-status').textContent = error.message; }
    }, 5000);
    subscribe({ api, state, ids, signal: subscription.signal, refresh,
      changed: event => { render(); if (event.kind === 'segment') tools.renderReview();
        if (event.kind === 'stream') refresh().catch(error => message(error.message)); },
      connection: value => { $('#connection').textContent = value; }
    }).catch(error => message(error.message));
  } catch (error) { token = ''; message(error.message); }
  finally { submit.disabled = false; }
});
$('#logout').addEventListener('click', () => {
  if (captureCount()) { message('탭 음성 수집을 중지한 뒤 로그아웃해 주세요.'); return; }
  subscription?.abort(); clearInterval(monitorTimer); token = ''; streams = []; monitoring = []; state.reset({ event_id: 0, segments: [] }); tools.stopPreview();
  $('#workspace').hidden = true; $('#logout').hidden = true; $('#auth').hidden = false;
  $('#register').reset(); $('#correct').reset(); $('#settings-form').reset(); tools.renderReview();
  $('#connection').textContent = '관리자 인증 대기'; message('로그아웃했습니다. 서버에서 수집 중인 방송은 계속 처리합니다.'); $('#token').focus();
});
for (const button of document.querySelectorAll('[data-section]')) button.addEventListener('click', () => {
  for (const pane of document.querySelectorAll('.admin-section')) pane.hidden = pane.id !== button.dataset.section;
  for (const tab of document.querySelectorAll('[data-section]')) tab.setAttribute('aria-pressed', String(tab === button));
  if (button.dataset.section !== 'sync') tools.stopPreview();
});
$('#register-channel').addEventListener('change', event => fillStream(event.target.value));
$('#manage-channel').addEventListener('change', render);
$('#register').elements.kind.addEventListener('change', updateAutoInput);
$('#auto-toggle').addEventListener('click', async () => {
  const id = $('#manage-channel').value; const stream = streams.find(item => item.stream_id === id);
  if (!autoSupported(stream)) return;
  $('#auto-toggle').disabled = true;
  try {
    const enabled = stream.auto_start === false;
    await api('/api/admin/streams/' + id + '/auto', { method: 'POST', body: JSON.stringify({ enabled }) });
    if ($('#register-channel').value === id) $('#auto-start').checked = enabled;
    await refresh();
    message(enabled ? '자동 감지를 켰습니다. 방송 시작을 확인하면 원음 저장과 전사를 시작합니다.' : '자동 감지를 껐습니다. 진행 중인 수집은 수집 중지 버튼으로 종료합니다.');
  } catch (error) { message(error.message); } finally { renderMonitor(); }
});
$('#register').addEventListener('submit', async event => {
  event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)); const submit = $('#register button'); submit.disabled = true;
  try {
    await api('/api/admin/streams', { method: 'POST', body: JSON.stringify({ ...data, approved: data.approved === 'on', auto_start: data.auto_start === 'on' }) });
    await refresh(); message('방송을 저장했습니다. 자동 감지가 켜져 있으면 방송 시작 후 녹음·전사를 시작합니다.');
  } catch (error) { message(error.message); }
  finally { submit.disabled = false; }
});
async function collect(start) {
  const id = $('#manage-channel').value; const stream = streams.find(value => value.stream_id === id);
  if (!stream) { message('먼저 방송을 등록해 주세요.'); return; }
  $('#capture').disabled = true; $('#stop').disabled = true;
  try {
    if (stream.kind === 'capture') { if (start) await startCapture(id, api, message); else await stopCapture(id, api); }
    else await api('/api/admin/streams/' + id + (start ? '/start' : '/stop'), { method: 'POST' });
    if (!start && $('#register-channel').value === id) $('#auto-start').checked = false;
    await refresh(); message(start ? '수집을 시작했습니다. 방송 상태를 확인해 주세요.' : '수집을 중지하고 남은 음성을 처리합니다. 자동 감지도 껐습니다.');
  } catch (error) { message(error.message); }
  finally { $('#capture').disabled = false; $('#stop').disabled = false; }
}
$('#capture').addEventListener('click', () => collect(true)); $('#stop').addEventListener('click', () => collect(false));
window.addEventListener('beforeunload', event => { if (captureCount()) { event.preventDefault(); event.returnValue = ''; } });
render();
