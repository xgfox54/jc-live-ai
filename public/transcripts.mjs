import { speakerText } from './speakers.mjs';

export function formatElapsedTime(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '시간 미확인';
  const seconds = Math.floor(milliseconds / 1000);
  const hours = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor(seconds / 60) % 60).padStart(2, '0');
  const remainder = String(seconds % 60).padStart(2, '0');
  return hours + '시간 ' + minutes + '분 ' + remainder + '초';
}

// One formatter serves every sentence. Creating it for each of 1,679 sentences took 85 of 93 ms (2026-11-21).
let receivedFormat;
export function formatReceivedTime(milliseconds) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0 || milliseconds > 8640000000000000) return '시각 미확인';
  receivedFormat ??= new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
  const parts = Object.fromEntries(receivedFormat.formatToParts(milliseconds).map(part => [part.type, part.value]));
  return `${parts.year}.${parts.month}.${parts.day} ${parts.hour}시 ${parts.minute}분 ${parts.second}초`;
}

export function transcriptNodes(items, options = {}) {
  if (options.publicOnly) items = items.filter(item => (item.ai_corrected === true || (options.livePreview && item.display_state === 'draft'))
    && typeof item.text === 'string' && item.text.trim());
  const fragment = document.createDocumentFragment();
  if (!items.length) {
    const empty = document.createElement('p'); empty.className = 'empty';
    empty.textContent = options.empty ?? '아직 표시할 회의록 받아쓰기가 없습니다.'; fragment.append(empty);
  }
  for (const item of items) {
    const line = document.createElement('div'); line.className = 'segment';
    const draft = options.livePreview && item.display_state === 'draft';
    if (draft) line.classList.add('segment-draft');
    line.id = 'segment-' + item.segment_id;
    const time = document.createElement('small');
    // A green dot (style.css) marks sentences already replaced by their AI-corrected text.
    const state = document.createElement('span');
    state.textContent = options.publicOnly ? draft ? '1차 받아쓰기 · 후보정 대기' : 'AI 후보정' : item.corrected_text == null ? 'AI 초안' : '검토문';
    if (options.publicOnly && !draft) state.className = 'correction-done';
    time.append((options.publicOnly ? '수신 ' + formatReceivedTime(item.audio_received_ms) + ' · 영상 시간 ' : '')
      + formatElapsedTime(item.start_ms) + ' ~ ' + formatElapsedTime(item.end_ms) + ' · ', state, ...(speakerText(item) ? [' · ' + speakerText(item)] : []));
    const text = document.createElement('span'); text.textContent = options.publicOnly ? item.text : options.mode === 'raw' ? item.raw_text : item.corrected_text ?? item.raw_text; line.append(time, text);
    if (!options.publicOnly && options.mode === 'both' && item.corrected_text != null) {
      const raw = document.createElement('p'); raw.className = 'help'; raw.textContent = '원문: ' + item.raw_text; line.append(raw);
    }
    if (item.repeated) { const note = document.createElement('small'); note.textContent = '반복 의심 문장입니다. 실제 반복 발언인지 원음으로 확인해 주세요.'; line.append(note); }
    if (options.audio) {
      const play = document.createElement('button'); play.className = 'secondary'; play.textContent = '이 구간 원음 듣기';
      play.addEventListener('click', () => options.audio(item)); line.append(play);
    }
    if (options.identity) {
      const identify = document.createElement('button'); identify.className = 'secondary'; identify.textContent = '이 구간 발언자 확인';
      identify.addEventListener('click', () => options.identity(item)); line.append(identify);
    }
    if (options.speaker) {
      const label = document.createElement('label'); label.textContent = '참여자 번호';
      const select = document.createElement('select'); select.append(new Option('미지정', ''));
      for (let i = 1; i <= 8; i++) select.append(new Option('참여자 ' + i, String(i)));
      select.value = item.speaker_id ? String(item.speaker_id) : '';
      select.addEventListener('change', () => options.speaker(item, select.value ? Number(select.value) : null)); label.append(select); line.append(label);
    }
    if (options.select) {
      const edit = document.createElement('button'); edit.className = 'secondary'; edit.textContent = '이 문장 수정';
      edit.addEventListener('click', () => options.select(item)); line.append(edit);
    }
    fragment.append(line);
  }
  return fragment;
}
