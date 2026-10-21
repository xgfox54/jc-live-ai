import { readFileSync, readdirSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const lock = JSON.parse(readFileSync(resolve(root, 'web/package-lock.json'), 'utf8'));
const records = [];
for (const [path, dependency] of Object.entries(lock.packages).filter(([path]) => path)) {
  const directory = resolve(root, 'web', path);
  const pkg = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
  const notices = readdirSync(directory).filter(name => /^(license|copying|notice)(\.|$)/i.test(name));
  if (!notices.length && pkg.name !== 'is-node-process') throw new Error('Missing license: ' + pkg.name);
  const target = resolve(root, 'licenses', 'web', pkg.name.replaceAll('/', '__') + '-' + pkg.version);
  mkdirSync(target, { recursive: true });
  for (const name of notices) copyFileSync(resolve(directory, name), resolve(target, name));
  if (!notices.length) copyFileSync(resolve(directory, 'package.json'), resolve(target, 'package.json'));
  records.push({ name: pkg.name, version: pkg.version, license: pkg.license, source: dependency.resolved,
    integrity: dependency.integrity, notices: (notices.length ? notices : ['package.json']).map(name => 'web/' + pkg.name.replaceAll('/', '__') + '-' + pkg.version + '/' + name),
    ...(!notices.length ? { notice_status: 'MIT declared in package metadata; no standalone license supplied in npm package or upstream v1.2.0 tag 8a6152c795d8705be97166bd5167e70ac6efc67c' } : {}) });
}
writeFileSync(resolve(root, 'licenses/web-manifest.json'), JSON.stringify(records, null, 2) + '\n');
console.log(JSON.stringify({ packages: records.length, notices: records.reduce((sum, record) => sum + record.notices.length, 0) }));
