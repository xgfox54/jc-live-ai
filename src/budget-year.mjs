// Whisper hears 이천이십칠 년도 as "2017년도" in budget hearings (2026-11-24 check: seven public sentences in five meetings on
// the 2027 budget, such as "경제활력국 소관 2017년도 예산안 및 기금운용계획안"). In a meeting whose official agenda reviews the
// budget of year Y, the year ten years earlier is written as Y when a budget document is named within 30 characters after it,
// in the same sentence or at the start of the next one, with no sentence ending between. Other mentions of that year
// ("2017년부터", "2017년 계획에는") stay.
const DOCUMENT = /예산안|기금운용계획안|공유재산관리계획안|교육비특별회계/;
export function budgetYear(agenda) {
  const match = /(20\d\d)\s*년도[^\n]{0,60}?(?:예산안|기금운용계획안|공유재산관리계획안)/.exec(String(agenda ?? ''));
  return match ? Number(match[1]) : null;
}
// rows are one meeting's sentences in order. text reads a row's sentence and write returns the row with a new sentence.
export function budgetYears(rows, agenda, text = row => row.corrected_text, write = (row, value) => ({ ...row, corrected_text: value })) {
  const year = budgetYear(agenda); if (!year) return rows;
  const wrong = String(year - 10); const pattern = new RegExp('(?<!\\d)' + wrong + '(?=\\s*년)', 'g');
  return rows.map((row, index) => {
    const value = text(row); if (typeof value !== 'string' || !value.includes(wrong)) return row;
    const following = rows[index + 1]?.session_id === row.session_id ? String(text(rows[index + 1]) ?? '') : '';
    const fixed = value.replace(pattern, (found, offset) => {
      const window = (value.slice(offset) + ' ' + following).slice(0, 40); const named = DOCUMENT.exec(window);
      return named && named.index <= 30 && !/[.?!]|니다|니까/.test(window.slice(0, named.index)) ? String(year) : found;
    });
    return fixed === value ? row : write(row, fixed);
  });
}
