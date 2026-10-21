import { speakerText } from './speakers.mjs';

export function transcriptNodes(items, options = {}) {
  if (options.publicOnly) items = items.filter(item => item.ai_corrected === true && typeof item.text === 'string' && item.text.trim());
  const fragment = document.createDocumentFragment();
  if (!items.length) {
    const empty = document.createElement('p'); empty.className = 'empty';
    empty.textContent = options.empty ?? '아직 표시할 회의록 받아쓰기가 없습니다.'; fragment.append(empty);
  }
  for (const item of items) {
    const line = document.createElement('div'); line.className = 'segment';
    line.id = 'segment-' + item.segment_id;
    const time = document.createElement('small');
    time.textContent = (item.start_ms / 1000).toFixed(1) + '초 ~ ' + (item.end_ms / 1000).toFixed(1)
      + '초 · ' + (options.publicOnly ? 'AI 후보정' : item.corrected_text == null ? 'AI 초안' : '검토문') + (speakerText(item) ? ' · ' + speakerText(item) : '');
    const text = document.createElement('span'); text.textContent = options.publicOnly ? item.text : options.mode === 'raw' ? item.raw_text : item.corrected_text ?? item.raw_text; line.append(time, text);
    if (!options.publicOnly && options.mode === 'both' && item.corrected_text != null) {
      const raw = document.createElement('p'); raw.className = 'help'; raw.textContent = '원문: ' + item.raw_text; line.append(raw);
    }
    if (item.repeated) { const note = document.createElement('small'); note.textContent = '반복 의심 문장입니다. 실제 반복 발언인지 원음으로 확인해 주세요.'; line.append(note); }
    if (options.audio) {
      const play = document.createElement('button'); play.className = 'secondary'; play.textContent = '이 구간 원음 듣기';
      play.addEventListener('click', () => options.audio(item)); line.append(play);
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
