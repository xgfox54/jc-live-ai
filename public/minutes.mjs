import './display.mjs';
import { retryWithJitter } from './polling.mjs';
import { speakerText, speakerColor, speakerKey } from './speakers.mjs';
import { newestMeetingsFirst, engineFromStatus, showEngineStatus, clockTime as time } from './client-state.mjs';
import { createLiveTransport } from './live-transport.mjs';
const $ = selector => document.querySelector(selector);
let selected = ''; let request = 0; let view = 'chapter'; let current = null; let replay = null;
const element = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const wide = window.matchMedia('(min-width: 1280px)');
const get = path => retryWithJitter(async () => {
  const response = await fetch(path);
  if (!response.ok) throw Object.assign(new Error('회의록을 불러오지 못했습니다. 다시 시도해 주세요.'), { retry: response.status >= 500 || response.status === 429 });
  return response.json();
});
function speakerBadge(item, names) {
  const text = speakerText(item, names); if (!text) return null;
  const badge = element('span', text, 'speaker-label'); const color = speakerColor(item.speaker_id);
  if (color) badge.style.setProperty('--speaker-color', color); else badge.classList.add('speaker-label-plain');
  return badge;
}
// The official council replay (다시보기) playlist of a meeting, or null.
function replayUrl(value) {
  try { const url = new URL(value?.replay?.media_url ?? ''); return url.protocol === 'https:' && url.hostname === 'vod.council.jeju.kr' ? url.href : null; }
  catch { return null; }
}
function quoteBlock(item, value, names) {
  const block = element('div', undefined, 'quote-block'); block.id = 'paragraph-' + item.segment_id;
  const label = element('p', undefined, 'quote-label');
  label.append('[' + (value.committee || '세션 ' + item.session_number) + ' / 구간 ' + item.epoch + ' / ' + (item.video_time ? '영상 ' : '') + time(item.start_ms) + '~' + time(item.end_ms));
  const badge = speakerBadge(item, names); if (badge) { label.append(' / '); label.append(badge); }
  label.append(']');
  const video = value.video_alignment?.video_id;
  if (item.video_time && replayUrl(value)) {
    const button = element('button', '이 시점 영상 보기', 'evidence'); button.type = 'button';
    button.setAttribute('aria-label', '이 시점 영상 보기, 영상 ' + time(item.start_ms));
    button.addEventListener('click', () => playReplay(value, item.start_ms / 1000)); label.append(' ', button);
  } else if (item.video_time && /^[A-Za-z0-9_-]{11}$/.test(video ?? '')) {
    const link = element('a', '영상에서 보기', 'video-link'); link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.href = 'https://www.youtube.com/watch?v=' + video + '&t=' + Math.floor(item.start_ms / 1000) + 's'; label.append(' ', link);
  }
  block.append(label, element('p', item.text, 'quote-text')); return block;
}
function stopReplay() {
  replay?.hls?.destroy(); replay = null;
  const video = $('#replay-video'); video.pause(); video.removeAttribute('src'); video.load();
  $('#replay').hidden = true; $('#replay-status').replaceChildren();
}
function replayFailed(value, message) {
  replay?.hls?.destroy(); if (replay) { replay.hls = null; replay.ready = false; }
  const status = $('#replay-status'); status.replaceChildren(message);
  let page = null;
  try { const url = new URL(value.replay?.page_url ?? ''); if (url.protocol === 'https:' && url.hostname === 'www.council.jeju.kr') page = url.href; } catch { /* no page link */ }
  if (page) { const link = element('a', '의회 다시보기 페이지에서 보기'); link.href = page; link.target = '_blank'; link.rel = 'noopener noreferrer'; status.append(' ', link); }
}
// Plays the official replay from a minutes time inside the page. hls.js loads on first use; browsers without it play HLS natively.
async function playReplay(value, seconds) {
  const url = replayUrl(value); if (!url) return;
  const video = $('#replay-video'); const status = $('#replay-status');
  if (!wide.matches) selectView('transcript');
  $('#replay').hidden = false;
  const play = state => video.play().catch(() => { if (replay === state) status.textContent = '재생 버튼을 눌러 영상을 시작해 주세요.'; });
  if (replay?.url === url && replay.ready) { video.currentTime = seconds; play(replay); return; }
  replay?.hls?.destroy(); const state = replay = { url, hls: null, ready: false };
  status.textContent = '공식 다시보기 영상을 불러오는 중입니다.';
  try {
    const { default: Hls } = await import('/hls.light.min.mjs');
    if (replay !== state) return;
    if (Hls.isSupported()) {
      const hls = state.hls = new Hls({ enableWorker: false, startPosition: seconds });
      hls.on(Hls.Events.MANIFEST_PARSED, () => { if (replay !== state) return; state.ready = true; status.textContent = ''; play(state); });
      hls.on(Hls.Events.ERROR, (event, data) => { if (data.fatal && replay === state) replayFailed(value, '영상을 불러오지 못했습니다.'); });
      hls.loadSource(url); hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.addEventListener('loadedmetadata', () => { if (replay !== state) return; state.ready = true; video.currentTime = seconds; status.textContent = ''; }, { once: true });
      video.addEventListener('error', () => { if (replay === state) replayFailed(value, '영상을 불러오지 못했습니다.'); }, { once: true });
      video.src = url; play(state);
    } else replayFailed(value, '이 브라우저에서는 영상을 재생할 수 없습니다.');
  } catch { if (replay === state) replayFailed(value, '영상을 불러오지 못했습니다.'); }
}
const roleText = entry => entry.speaker_role === 'member' ? ' 의원' : entry.speaker_role === 'official' ? ' · 공무원' : '';
// Evidence buttons jump to the paragraph that contains the cited recognition segment.
function evidenceButton(evidence) {
  const target = (evidence ?? []).find(item => item.segment_id); if (!target) return null;
  const button = element('button', '근거 보기', 'evidence'); button.type = 'button'; button.setAttribute('aria-label', '근거 발언으로 이동');
  button.addEventListener('click', () => showEvidence(target.segment_id, target.quote)); return button;
}
function factItem(text, evidence) { const item = element('li', text); const button = evidenceButton(evidence); if (button) item.append(' ', button); return item; }
// Marks the cited sentence inside the paragraph (text nodes only) and scrolls it into view.
function markQuote(block, quote) {
  const body = block.querySelector('.quote-text'); body.textContent = body.textContent;
  const text = body.textContent; const index = quote ? text.indexOf(quote.trim()) : -1;
  if (index < 0) return body;
  const mark = element('mark', text.slice(index, index + quote.trim().length));
  body.replaceChildren(text.slice(0, index), mark, text.slice(index + quote.trim().length)); return mark;
}
function showEvidence(segmentId, quote) {
  const block = [...document.querySelectorAll('#transcript-list .quote-block')].find(node => node.dataset.segments.split(' ').includes(segmentId));
  if (!block) { $('#transcript-count').textContent = '해당 발언을 받아쓰기에서 찾지 못했습니다.'; return; }
  if (!wide.matches) selectView('transcript');
  if (block.hidden) { $('#transcript-speaker').value = ''; $('#transcript-search').value = ''; filterTranscript(); }
  for (const node of document.querySelectorAll('.quote-block.is-target')) { node.classList.remove('is-target'); markQuote(node, ''); }
  block.classList.add('is-target'); const spot = markQuote(block, quote);
  const pane = $('#panel-transcript');
  if (wide.matches && pane.scrollHeight > pane.clientHeight) {
    pane.scrollTop += spot.getBoundingClientRect().top - pane.getBoundingClientRect().top - 96;
  } else spot.scrollIntoView({ block: 'center' });
  block.focus({ preventScroll: true });
}
function renderHead(value) {
  const head = $('#minutes-head'); head.replaceChildren(element('h2', value.title));
  const meta = [value.status === 'in_progress' ? '수집·작성 중' : '검토용 초안', value.scheduled_at || '일시 미확인',
    '발언자 ' + (value.participants ?? []).length + '명', value.segment_count + '개 전사 구간', '갱신 ' + new Date(value.updated_ms).toLocaleString('ko-KR')];
  head.append(element('p', meta.join(' · '), 'help'));
  const downloads = element('div', undefined, 'row');
  for (const [extension, label] of [['md', 'Markdown 내려받기'], ['json', 'JSON 내려받기']]) {
    const link = element('a', label); link.href = '/api/viewer/minutes/' + value.id + '.' + extension; link.download = ''; downloads.append(link);
  }
  head.append(downloads);
}
function renderChapter(value, names) {
  const panel = $('#panel-chapter'); panel.replaceChildren();
  const paragraphs = value.paragraphs ?? value.transcript; const participants = value.participants ?? [];
  const unassigned = paragraphs.filter(item => !item.speaker_key).length;
  panel.append(element('h3', '회의 정보'));
  const facts = element('dl', undefined, 'meeting-facts');
  for (const [label, text] of [['일시', value.scheduled_at], ['회차', value.meeting_round], ['회의', value.meeting_type], ['소관', value.committee],
    ['발언자', participants.length + '명' + (unassigned ? ' · 미확인 구간 ' + unassigned + '건' : '')], ['받아쓰기', value.segment_count + '개 구간 · ' + paragraphs.length + '개 문단']])
    facts.append(element('dt', label), element('dd', text || '미확인'));
  panel.append(facts);
  panel.append(element('h3', '회의 한줄 요약'));
  if (value.digest) {
    const overview = element('p', value.digest.overview.text, 'overview'); const button = evidenceButton(value.digest.overview.evidence); if (button) overview.append(' ', button);
    panel.append(overview, element('h3', '주요 논의 사항'));
    for (const topic of value.digest.topics) {
      panel.append(element('h4', topic.title)); const list = element('ul', undefined, 'point-list');
      for (const item of topic.items) list.append(factItem(item.text, item.evidence)); panel.append(list);
    }
  } else panel.append(element('p', value.timeline?.length ? 'AI 전체 요약을 아직 만들지 않았습니다. 핵심 내용 요약에서 시간순 요약을 확인해 주세요.'
    : value.status === 'in_progress' ? '수집 중입니다. 후보정이 완료된 발언으로 요약을 작성합니다.' : '요약할 발언이 아직 없습니다.', 'help'));
  panel.append(element('h3', '공식 심의 안건'), element('p', value.agenda || '공식 페이지에서 안건을 확인하지 못했습니다.', 'preserve-lines'));
  panel.append(element('h3', '발언자'));
  if (!participants.length) panel.append(element('p', '정리할 발언이 아직 없습니다.', 'help'));
  else {
    panel.append(element('p', ['complete', 'partial'].includes(value.final_speakers?.phase)
      ? '전체 발언 구간을 재검토했습니다. 이름 확인 ' + value.final_speakers.assigned + '개 구간 · 미확인 ' + value.final_speakers.unresolved + '개 구간. 이름은 원음과 공식 기록으로 확인해 주세요.'
      : value.status === 'in_progress' ? '번호는 실시간 분석의 임시 번호입니다. 회의가 끝나면 발언자를 자동으로 재검토합니다.'
        : '회의가 끝나 발언자 재검토를 기다리고 있습니다.', 'help'));
    const list = element('ul', undefined, 'speaker-list');
    for (const entry of participants) {
      const item = element('li'); const badge = speakerBadge({ ...entry, speaker_key: entry.key }, names);
      item.append(badge ?? entry.label, roleText(entry).replace(/^ · /, '') + ' · 발언 ' + entry.paragraph_count + '건 · 약 ' + Math.round(entry.seconds / 60) + '분');
      const button = element('button', '발언 보기', 'evidence'); button.type = 'button';
      button.addEventListener('click', () => { $('#transcript-speaker').value = entry.key; $('#transcript-search').value = ''; filterTranscript(); if (!wide.matches) selectView('transcript'); });
      item.append(' ', button); list.append(item);
    }
    if (unassigned) list.append(element('li', '발언자 미확인·교대 구간 · ' + unassigned + '건'));
    panel.append(list);
  }
  const links = element('div', undefined, 'source-links');
  for (const source of value.sources) {
    let url; try { url = new URL(source); } catch { continue; }
    if (url.protocol !== 'https:') continue;
    const link = element('a', source); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; links.append(link);
  }
  panel.append(element('h3', '출처'), links);
  const notes = element('details', undefined, 'minutes-notes'); notes.append(element('summary', '기록 범위 안내 ' + value.warnings.length + '건'));
  const warnings = element('ul'); for (const warning of value.warnings) warnings.append(element('li', warning)); notes.append(warnings);
  const reasons = { process_restart: '서버 재시작', queue_overflow: '전사 대기 초과', inference_failed: '음성 인식 실패',
    input_discontinuity: '입력 구간 변경', collector_failed: '음원 수집 실패', source_resolution_failed: '음원 주소 확인 실패',
    beginning_collection_failed: '방송 시작 부분 수집 실패', capture_transport_loss: '탭 공유 연결 중단' };
  for (const gap of value.gaps) warnings.append(element('li', '누락·중단: 세션 ' + gap.session_number + ' / 구간 ' + gap.epoch + ' / '
    + (gap.start_ms === null ? '범위 미확인' : time(gap.start_ms) + '~' + time(gap.end_ms ?? gap.start_ms)) + ' / ' + (reasons[gap.reason] ?? '입력 또는 전사 중단')));
  if (!value.gaps.length) warnings.append(element('li', '기록된 누락·중단이 없습니다. 전체 수록을 보장하는 의미는 아닙니다.'));
  panel.append(notes);
}
function renderPoints(value) {
  const panel = $('#panel-points'); panel.replaceChildren();
  if (!value.timeline?.length) { panel.append(element('p', value.status === 'in_progress' ? '수집 중입니다. 후보정이 완료된 발언으로 요약을 작성합니다.' : '요약할 발언이 아직 없습니다.', 'help')); return; }
  panel.append(element('p', '시간순으로 묶은 AI 요약입니다. 각 항목의 근거 발언을 받아쓰기에서 확인할 수 있습니다.' + (value.summary?.updated_ms ? ' 갱신 ' + new Date(value.summary.updated_ms).toLocaleString('ko-KR') : ''), 'help'));
  for (const group of value.timeline) {
    const article = element('article', undefined, 'timeline-group');
    const videoClock = typeof group.video_time === 'boolean' ? group.video_time
      : (value.replay ?? value.video_alignment)?.sessions?.some(session => session.session_number === group.session_number);
    article.append(element('p', (value.session_count > 1 && !videoClock ? '세션 ' + group.session_number + ' · ' : '') + (videoClock ? '영상 ' : '') + time(group.start_ms), 'timeline-time'));
    article.append(element('h4', group.title || '구간 ' + (group.group + 1) + ' 논의'));
    const list = element('ul', undefined, 'point-list');
    for (const item of group.items) list.append(factItem(item.text, item.segment_id ? [{ segment_id: item.segment_id, quote: item.quote }] : []));
    article.append(list); panel.append(article);
  }
}
function renderTranscript(value, names) {
  const list = $('#transcript-list'); list.replaceChildren();
  const select = $('#transcript-speaker'); select.replaceChildren(new Option('전체', ''));
  for (const entry of value.participants ?? []) select.append(new Option(entry.label + roleText(entry).replace(' · ', ' '), entry.key));
  if ((value.paragraphs ?? []).some(item => !item.speaker_key)) select.append(new Option('발언자 미확인·교대 구간', 'unassigned'));
  $('#transcript-search').value = '';
  for (const item of value.paragraphs ?? value.transcript) {
    const block = quoteBlock(item, value, names); block.tabIndex = -1;
    block.dataset.segments = (item.segment_ids ?? [item.segment_id]).filter(Boolean).join(' '); block.dataset.speaker = item.speaker_key ?? 'unassigned';
    list.append(block);
  }
  filterTranscript();
}
function filterTranscript() {
  const speaker = $('#transcript-speaker').value; const query = $('#transcript-search').value.trim().toLocaleLowerCase(); let shown = 0;
  const blocks = document.querySelectorAll('#transcript-list .quote-block');
  for (const block of blocks) {
    const visible = (!speaker || block.dataset.speaker === speaker) && (!query || block.querySelector('.quote-text').textContent.toLocaleLowerCase().includes(query));
    block.hidden = !visible; if (visible) shown++;
  }
  $('#transcript-count').textContent = blocks.length ? (speaker || query ? shown + '개 문단 표시 · 전체 ' + blocks.length + '개' : blocks.length + '개 문단')
    : current?.status === 'in_progress' ? 'AI 후보정이 완료된 문장을 기다립니다.' : '받아쓰기가 아직 없습니다.';
}
function selectView(next) {
  view = next;
  // On narrow screens the replay lives in the transcript view; it is paused when that view is hidden.
  if (next !== 'transcript' && !wide.matches) $('#replay-video').pause();
  for (const tab of document.querySelectorAll('#minutes-tabs [role=tab]')) {
    const active = tab.dataset.view === next; tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
  }
  $('#panel-chapter').hidden = next !== 'chapter'; $('#panel-points').hidden = next !== 'points';
  $('#minutes-detail').classList.toggle('transcript-mode', next === 'transcript');
  $('#minutes-body').classList.toggle('with-side', next !== 'transcript'); $('#minutes-body').classList.toggle('transcript-only', next === 'transcript');
}
function render(value) {
  current = value;
  if (replay && replay.url !== replayUrl(value)) stopReplay();
  if (value.publication_policy !== 'ai-corrected-v1' || !Array.isArray(value.transcript) || value.transcript.some(item => item.ai_corrected !== true)) {
    $('#minutes-head').replaceChildren(element('h2', '회의록 준비 중'), element('p', 'AI 후보정이 완료된 공개 자료를 기다립니다.'));
    $('#minutes-tabs').hidden = true; $('#minutes-body').hidden = true; return;
  }
  const names = Object.fromEntries((value.participants ?? []).filter(entry => entry.named).map(entry => [entry.key, entry.label]));
  renderHead(value); renderChapter(value, names); renderPoints(value); renderTranscript(value, names);
  $('#minutes-tabs').hidden = false; $('#minutes-body').hidden = false; selectView(view);
}
async function select(id) {
  selected = id; const current = ++request;
  try {
    const value = await get('/api/viewer/minutes/' + id);
    if (current !== request) return; render(value);
    for (const button of document.querySelectorAll('[data-minutes]')) button.setAttribute('aria-pressed', String(button.dataset.minutes === id));
    $('#minutes-notice').textContent = '';
  } catch (error) { if (current === request) $('#minutes-notice').textContent = error.message; }
}
async function refresh() {
  $('#reload').disabled = true;
  try {
    const items = newestMeetingsFirst((await get('/api/viewer/minutes')).items); const list = $('#minutes-list'); list.replaceChildren();
    if (!items.length) list.append(element('p', '작성된 회의록이 없습니다.', 'help'));
    for (const item of items) {
      const button = element('button', undefined, 'secondary minutes-item'); button.dataset.minutes = item.id;
      button.setAttribute('aria-pressed', String(item.id === selected));
      button.append(element('strong', item.title), element('span', (item.status === 'in_progress' ? '작성 중' : '검토용 초안')
        + ' · ' + item.segment_count + '개 구간', 'help'));
      button.addEventListener('click', () => select(item.id)); list.append(button);
    }
    if (selected && items.some(item => item.id === selected)) await select(selected);
    else if (items.length) await select(items[0].id);
    $('#minutes-notice').textContent = items.length ? '회의록 ' + items.length + '건을 불러왔습니다.' : '수집이 시작되면 회의록을 자동으로 작성합니다.';
  } catch (error) { $('#minutes-notice').textContent = error.message; }
  finally { $('#reload').disabled = false; }
}
$('#reload').addEventListener('click', refresh); refresh();
// The engine indicator is checked when the page opens and when it becomes visible again, at most once a minute.
const liveTransport = createLiveTransport(); let engineChecked = -Infinity;
async function checkEngine() {
  if (document.visibilityState === 'hidden' || Date.now() - engineChecked < 60_000) return;
  engineChecked = Date.now();
  try {
    const response = await liveTransport.fetch('/api/status', { signal: AbortSignal.timeout(10_000) });
    showEngineStatus($('#engine-status'), response.ok ? (await response.json()).engine : engineFromStatus(response.status));
  } catch {
    // A failure of the viewer's own connection says nothing about the engine, so the last state stays.
  }
}
document.addEventListener('visibilitychange', checkEngine); checkEngine();
for (const tab of document.querySelectorAll('#minutes-tabs [role=tab]')) tab.addEventListener('click', () => selectView(tab.dataset.view));
$('#minutes-tabs').addEventListener('keydown', event => {
  const tabs = [...document.querySelectorAll('#minutes-tabs [role=tab]')]; const index = tabs.findIndex(tab => tab.dataset.view === view);
  const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 }[event.key]; if (next === undefined) return;
  event.preventDefault(); const tab = tabs[(next + tabs.length) % tabs.length]; selectView(tab.dataset.view); tab.focus();
});
$('#transcript-speaker').addEventListener('change', filterTranscript); $('#transcript-search').addEventListener('input', filterTranscript);
$('#replay-close').addEventListener('click', stopReplay);
