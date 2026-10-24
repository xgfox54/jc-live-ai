import { committees } from '../public/committees.mjs';

// Imported from the Jeju glossary, not a verified list of current office holders.
export const streamRecordPeople = Object.freeze({
  repository: 'https://gitlab.aigov.go.kr/memory365/streamrecord',
  commit: '6b8701e89f48a6e79891343575c24177162269a6', version: 'v0.8.1',
  file: 'app/frontend/src/components/stream-record/glossary-packs.ts',
  checked_at: '2026-10-22', names: ['김희찬', '위성곤', '양순철'], complete_official_roster: false,
});
const provincialTitles = new Set(['제주특별자치도지사', '도지사', '행정부지사', '정무부지사', '기후경제부지사', '기획조정실장',
  '안전건강실장', '특별자치행정국장', '안전국장', '복지가족국장', '경제활력국장', '교통항공국장', '기후환경국장',
  '농축산식품국장', '해양수산국장', '건설주택국장', '문화체육국장', '관광교류국장', '문화관광체육국장',
  '소방안전본부장', '상하수도본부장', '세계유산본부장', '농업기술원장', '보건환경연구원장', '공공정책연수원장', '중앙협력본부장']);
const officialTitle = title => provincialTitles.has(title) || /^(?:제주|서귀포)시장$/.test(title)
  || /^(?:제주시|서귀포시)(?:부시장|[가-힣]{2,12}국장)$/.test(title) && !/체육회|협회|재단|공사|공단/.test(title);
export function peopleCandidates(record, directory, attendance = []) {
  const committee = committees.find(item => item.stream_id === record.stream_id || item.name === record.committee);
  // Plenary and other channel-0 broadcasts involve every member, so all committee rosters are candidates.
  const members = (committee?.members.length ? [committee] : committees).flatMap(item => item.members)
    .map(member => ({ name: member.name, role: 'member', title: member.role, source: 'committee-directory' }));
  const officials = [];
  const date = String(record.scheduled_at ?? record.meeting_date ?? '').slice(0, 10);
  const exactMeetings = (directory?.meetings ?? []).filter(meeting => {
    const sourceMatch = (record.sources ?? []).some(source => String(source).match(/[?&]fidx=(\d+)/)?.[1] === String(meeting.fidx));
    const topic = record.committee || committee?.name;
    return sourceMatch || Boolean(date && meeting.date === date && topic && meeting.title?.includes(topic)
      && (!record.meeting || meeting.title.includes(record.meeting)));
  });
  const attended = exactMeetings.flatMap(meeting => (meeting.labels ?? []).flatMap(label => {
    const match = label.match(/^(.{1,45})\s+([가-힣]{2,5})$/); if (!match) return [];
    return [{ name: match[2], role: /^(?:의장|부의장|위원장|부위원장|의원|위원)$/.test(match[1]) ? 'member' : 'official',
      title: match[1], as_of: meeting.date, attendance: true, source: 'https://record.council.jeju.kr/source/view/video.html?fidx=' + meeting.fidx + '&pos=1&angun=0' }];
  }));
  // Plenary sessions are presided by the council 의장 or a 부의장, who sit on no standing committee.
  // The latest official speaker records up to the meeting date give one 의장 and at most two 부의장.
  const officers = new Map(); const officerLimit = { 의장: 1, 부의장: 2 };
  const meetings = [...(directory?.meetings ?? [])].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  for (const meeting of committee?.members.length ? [] : meetings) {
    if (!meeting.date || (date && meeting.date > date)) continue;
    for (const label of meeting.labels ?? []) {
      const match = label.match(/^(의장|부의장)\s+([가-힣]{2,4})$/);
      if (!match || officers.has(match[2]) || [...officers.values()].filter(item => item.office === match[1]).length >= officerLimit[match[1]]) continue;
      officers.set(match[2], { office: match[1], as_of: meeting.date,
        source: 'https://record.council.jeju.kr/source/view/video.html?fidx=' + meeting.fidx + '&pos=1&angun=0' });
    }
  }
  const latestTitles = new Set();
  for (const meeting of meetings) {
    if (!meeting.date || (date && meeting.date > date)) continue;
    for (const label of meeting.labels ?? []) {
      const match = label.match(/^(.{2,35}(?:국장|실장|도지사|부지사|시장|부시장|본부장|원장))\s+([가-힣]{2,5})$/);
      if (!match || !officialTitle(match[1]) || latestTitles.has(match[1])) continue;
      latestTitles.add(match[1]);
      officials.push({ name: match[2], role: 'official', title: match[1], as_of: meeting.date,
        source: 'https://record.council.jeju.kr/source/view/video.html?fidx=' + meeting.fidx + '&pos=1&angun=0' });
    }
  }
  const names = new Map();
  const officerPeople = [...officers].map(([name, item]) => ({ name, role: 'member', title: item.office, ...item }));
  for (const person of [...attendance.filter(person => !date || person.as_of === date), ...attended, ...members, ...officerPeople, ...officials,
    ...streamRecordPeople.names.map(name => ({ name, role: 'unknown', title: '', source: 'stream-record:' + streamRecordPeople.commit }))])
    if (!names.has(person.name)) names.set(person.name, person);
    else if (person.office && names.get(person.name).role === 'member') names.set(person.name, { ...names.get(person.name), office: person.office, as_of: person.as_of });
  return [...names.values()].slice(0, 160);
}
export function peopleGlossary(record, directory) {
  return peopleCandidates(record, directory).map(person => [person.title, person.name].filter(Boolean).join(' '));
}
