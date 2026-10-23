import { committeeForChannel } from './committees.mjs';

export function committeeMembers(streamId) {
  const committee = committeeForChannel(streamId);
  const aside = document.createElement('aside'); aside.className = 'committee-members';
  // Channel 0 (plenary and other non-committee broadcasts) has no committee roster.
  if (!committee || !committee.members.length) { aside.hidden = true; return aside; }
  aside.setAttribute('aria-label', committee.name + ' 의원 명단');
  const details = document.createElement('details'); details.open = true;
  const summary = document.createElement('summary'); summary.textContent = '위원 명단 · ' + committee.members.length + '명';
  const heading = document.createElement('h3'); heading.textContent = committee.name;
  const list = document.createElement('ul'); list.className = 'member-list';
  for (const member of committee.members) {
    const row = document.createElement('li'); row.className = 'member-row'; row.dataset.member = member.id;
    const image = document.createElement('img'); image.src = member.photo; image.alt = member.name + ' 의원 사진';
    image.width = 48; image.height = 64; image.loading = 'lazy'; image.decoding = 'async';
    const missing = document.createElement('span'); missing.className = 'member-photo-missing'; missing.textContent = '사진 없음'; missing.hidden = true;
    image.addEventListener('error', () => { image.hidden = true; missing.hidden = false; });
    const info = document.createElement('div'); const link = document.createElement('a'); link.href = member.profile_url;
    link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = member.name;
    link.setAttribute('aria-label', member.name + ' 의원 공식 소개 (새 창)');
    const role = document.createElement('span'); role.className = 'member-role'; role.textContent = member.role;
    const area = document.createElement('span'); area.className = 'member-area'; area.textContent = member.constituency;
    info.append(link, role, area); row.append(image, missing, info); list.append(row);
  }
  const source = document.createElement('a'); source.className = 'member-source'; source.href = committee.source_url;
  source.target = '_blank'; source.rel = 'noopener noreferrer'; source.textContent = '도의회 공식 명단·사진';
  const checked = document.createElement('p'); checked.className = 'help';
  checked.textContent = '확인 ' + new Date(committee.checked_at).toLocaleDateString('ko-KR') + ' · 홈페이지 게시 명단입니다.';
  details.append(summary, heading, list, source, checked); aside.append(details); return aside;
}
