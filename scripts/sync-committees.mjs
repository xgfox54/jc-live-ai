import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const origin = 'https://www.council.jeju.kr';
const definitions = [
  ['O01', '의회운영위원회', 'committee/committee01'], ['O02', '행정자치위원회', 'committee/committee02'],
  ['O03', '보건복지안전위원회', 'committee/committee03'], ['O22', '미래경제산업위원회', 'committee/committee08'],
  ['O04', '환경도시위원회', 'committee/committee04'], ['O05', '문화관광체육위원회', 'committee/committee05'],
  ['O06', '농수축위원회', 'committee/committee06'], ['O07', '교육위원회', 'committee/committee07'],
  ['O08', '예산결산특별위원회', 'special/committee08'], ['O09', '윤리특별위원회', 'special/committee09'],
  ['special43', '4·3특별위원회', 'special/committee25'], ['regulation', '규제개혁특별위원회', 'special/committee26']
];
const clean = value => value.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
const digest = value => createHash('sha256').update(value).digest('hex');
async function download(url, redirects = 0) {
  if (new URL(url).origin !== origin || redirects > 5) throw new Error('Unexpected official source redirect');
  const response = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'manual' });
  if ([301, 302, 303, 307, 308].includes(response.status)) return download(new URL(response.headers.get('location'), url).href, redirects + 1);
  if (!response.ok) throw new Error(`Official source failed: ${response.status} ${url}`);
  return Buffer.from(await response.arrayBuffer());
}
export function parseMembers(html) {
  return [...html.matchAll(/<div class="chair(?: chairman)?\s*">([\s\S]*?)<\/div>/g)].map(([, block]) => {
    const profile = block.match(/href="(\/member\/[^"\s]+)"/);
    const photo = block.match(/src="(\/upload\/member\/[a-f\d-]+\.jpg)"/i);
    const identity = block.match(/>\s*(위원장|부위원장|의원)\s*:\s*([^<]+)<\/a>/);
    const constituency = block.match(/선거구\s*:<\/b>\s*<span>([^<]+)<\/span>/);
    if (!profile || !photo || !identity || !constituency) throw new Error('Unrecognized official member row');
    return { id: profile[1].split('/')[2], name: clean(identity[2]), role: identity[1],
      constituency: clean(constituency[1]), profile_url: origin + profile[1], photo_source: origin + photo[1],
      photo: '/member-' + photo[1].split('/').at(-1) };
  });
}
export async function syncCommittees() {
  const output = new URL('../public/', import.meta.url);
  const evidence = new URL('../reports/committee-sources/', import.meta.url);
  await mkdir(evidence, { recursive: true });
  const checked_at = new Date().toISOString(); const committees = []; const photos = new Map(); const pages = [];
  for (const [index, [id, name, path]] of definitions.entries()) {
    const source_url = origin + '/council/committees/' + path + (index < 8 ? '.do' : '/introduce.do');
    const bytes = await download(source_url); const members = parseMembers(bytes.toString('utf8'));
    if (members.length < 3 || members.filter(m => m.role === '위원장').length !== 1
      || new Set(members.map(m => m.id)).size !== members.length) throw new Error('Invalid roster: ' + name);
    await writeFile(new URL(id + '.html', evidence), bytes);
    pages.push({ id, source_url, sha256: digest(bytes), members: members.length });
    for (const member of members) photos.set(member.photo, member.photo_source);
    committees.push({ id, name, stream_id: 'ch' + (index + 1), category: index < 8 ? '상임위원회' : '특별위원회',
      source_url, checked_at, members });
  }
  const images = [];
  for (const [photo, source_url] of photos) {
    const bytes = await download(source_url);
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.length < 1000) throw new Error('Invalid official photograph: ' + source_url);
    await writeFile(new URL(photo.slice(1), output), bytes);
    images.push({ photo, source_url, bytes: bytes.length, sha256: digest(bytes) });
  }
  await writeFile(new URL('committees.mjs', output), 'export const committees = ' + JSON.stringify(committees, null, 2) + ';\n'
    + 'export const CHANNEL_IDS = committees.map(committee => committee.stream_id);\n'
    + 'export const committeeForChannel = id => committees.find(committee => committee.stream_id === id);\n');
  const manifest = { checked_at, pages, images };
  await writeFile(new URL('manifest.json', evidence), JSON.stringify(manifest, null, 2));
  const provenance = new URL('../licenses/committee-members/', import.meta.url); await mkdir(provenance, { recursive: true });
  await writeFile(new URL('manifest.json', provenance), JSON.stringify(manifest, null, 2));
  return { committees: committees.length, members: committees.reduce((n, c) => n + c.members.length, 0), photos: images.length };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await syncCommittees()));
