const $ = selector => document.querySelector(selector);
let selected = ''; let request = 0;
const element = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const time = ms => { const s = Math.floor(ms / 1000); return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(n => String(n).padStart(2, '0')).join(':'); };
async function get(path) { const response = await fetch(path); if (!response.ok) throw new Error('회의록을 불러오지 못했습니다. 다시 시도해 주세요.'); return response.json(); }
function render(value) {
  const article = $('#minutes-detail'); article.replaceChildren();
  article.append(element('h2', value.title), element('p', (value.status === 'in_progress' ? '수집·작성 중' : '검토용 초안')
    + ' · ' + value.segment_count + '개 전사 구간 · 갱신 ' + new Date(value.updated_ms).toLocaleString('ko-KR'), 'help'));
  const downloads = element('div', undefined, 'row');
  for (const [extension, label] of [['md', 'Markdown 내려받기'], ['json', 'JSON 내려받기']]) {
    const link = element('a', label); link.href = '/api/viewer/minutes/' + value.id + '.' + extension; link.download = ''; downloads.append(link);
  }
  article.append(downloads);
  const warnings = element('ul'); for (const warning of value.warnings) warnings.append(element('li', warning)); article.append(warnings);
  article.append(element('h3', '회의 정보'));
  for (const [label, text] of [['일시', value.scheduled_at], ['회차', value.meeting_round], ['회의', value.meeting_type], ['소관', value.committee]])
    article.append(element('p', label + ': ' + (text || '미확인')));
  const links = element('div', undefined, 'source-links');
  for (const source of value.sources) {
    let url; try { url = new URL(source); } catch { continue; }
    if (url.protocol !== 'https:') continue;
    const link = element('a', source); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; links.append(link);
  }
  article.append(element('h3', '출처'), links, element('h3', '공식 심의 안건'),
    element('p', value.agenda || '공식 페이지에서 안건을 확인하지 못했습니다.', 'preserve-lines'));
  for (const [heading, items] of [['주요 논의 발췌', value.discussion], ['의결 관련 발언 발췌', value.decision_quotes], ['요청·후속 조치 관련 발언 발췌', value.action_quotes]]) {
    article.append(element('h3', heading));
    if (!items.length) article.append(element('p', '해당 발언을 전사문에서 확인하지 못했습니다.', 'help'));
    for (const item of items) {
      article.append(element('p', '세션 ' + item.session_number + ' / 구간 ' + item.epoch + ' / ' + time(item.start_ms) + '~' + time(item.end_ms), 'help'), element('p', item.text));
    }
  }
  const details = element('details'); details.append(element('summary', '전체 전사문 ' + value.segment_count + '개 구간'));
  for (const item of value.transcript) details.append(element('p', '[세션 ' + item.session_number + ' / 구간 ' + item.epoch + ' / '
    + time(item.start_ms) + '~' + time(item.end_ms) + '] ' + item.text));
  article.append(details, element('h3', '누락·중단 기록'));
  if (!value.gaps.length) article.append(element('p', '기록된 누락·중단이 없습니다. 전체 수록을 보장하는 의미는 아닙니다.', 'help'));
  const reasons = { process_restart: '서버 재시작', queue_overflow: '전사 대기 초과', inference_failed: '음성 인식 실패',
    input_discontinuity: '입력 구간 변경', collector_failed: '음원 수집 실패', source_resolution_failed: '음원 주소 확인 실패',
    beginning_collection_failed: '방송 시작 부분 수집 실패', capture_transport_loss: '탭 공유 연결 중단' };
  for (const gap of value.gaps) article.append(element('p', '세션 ' + gap.session_number + ' / 구간 ' + gap.epoch + ' / '
    + (gap.start_ms === null ? '범위 미확인' : time(gap.start_ms) + '~' + time(gap.end_ms ?? gap.start_ms)) + ' / ' + (reasons[gap.reason] ?? '입력 또는 전사 중단')));
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
    const { items } = await get('/api/viewer/minutes'); const list = $('#minutes-list'); list.replaceChildren();
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
