// Names and titles from the speaker labels of recent official minutes of the same committee, newest first.
const committeeOf = title => title.replace(/\s+/g, '').replace(/\(.*$/, '')
  .replace(/제\d+회|제\d+차|정례회|임시회|\[폐회중\]|개회식,?|\d+일차/g, '').slice(0, 3);
export function speakerGlossary(meetings, title, { meetingsLimit = 6, limit = 80 } = {}) {
  const committee = committeeOf(title);
  const same = meetings.filter(meeting => committee && committeeOf(meeting.title ?? '') === committee)
    .sort((a, b) => b.date.localeCompare(a.date)).slice(0, meetingsLimit);
  const counts = new Map();
  for (const meeting of same) for (const label of meeting.labels) {
    const clean = label.replace(/\s+/g, ' ').trim();
    if (/^[가-힣·()0-9 ]{3,30}$/.test(clean) && / [가-힣]{2,4}$/.test(clean)) counts.set(clean, (counts.get(clean) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([label]) => label);
}

