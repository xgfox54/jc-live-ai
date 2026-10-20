export function transcriptNodes(items, options = {}) {
  const fragment = document.createDocumentFragment();
  if (!items.length) {
    const empty = document.createElement('p'); empty.className = 'empty';
    empty.textContent = options.empty ?? '아직 표시할 전사문이 없습니다.'; fragment.append(empty);
  }
  for (const item of items) {
    const line = document.createElement('div'); line.className = 'segment';
    const time = document.createElement('small');
    time.textContent = (item.start_ms / 1000).toFixed(1) + '초 ~ ' + (item.end_ms / 1000).toFixed(1)
      + '초 · ' + (item.corrected_text == null ? 'AI 초안' : '검토문');
    const text = document.createElement('span'); text.textContent = item.corrected_text ?? item.raw_text; line.append(time, text);
    if (options.select) {
      const edit = document.createElement('button'); edit.className = 'secondary'; edit.textContent = '이 문장 수정';
      edit.addEventListener('click', () => options.select(item)); line.append(edit);
    }
    fragment.append(line);
  }
  return fragment;
}
