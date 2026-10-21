import { cpSync, mkdirSync, rmSync, readdirSync, statSync, createReadStream, writeFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, join, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Usage: node scripts/package-backup.mjs <staging-root> <previous-handoff-root>
// Builds the Google Drive continuity package: source payload, git bundle, private state, manifests, split archive.
const root = resolve(process.argv[2]); const previous = resolve(process.argv[3] ?? '');
const repo = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const stamp = process.argv[4] ?? new Date().toISOString().slice(0, 10).replace(/-/g, '');
const sha256 = path => new Promise((done, fail) => { const hash = createHash('sha256'); createReadStream(path).on('data', part => hash.update(part)).on('end', () => done(hash.digest('hex'))).on('error', fail); });
const skip = new Set(['.git', 'node_modules', 'data', 'target', '.ruff_cache', '__pycache__', 'config.local.json', '.playwright-mcp']);
const skipPaths = new Set(['web/public', 'reports/live-diarization-20261021/quality-tools']);
if (existsSync(root)) throw new Error('Staging root exists: ' + root);
mkdirSync(join(root, 'JC-LIVE'), { recursive: true });
cpSync(repo, join(root, 'JC-LIVE'), { recursive: true, filter: source => {
  const rel = relative(repo, source).split(sep).join('/'); if (!rel) return true;
  return !rel.split('/').some(part => skip.has(part)) && ![...skipPaths].some(path => rel === path || rel.startsWith(path + '/'));
} });
execFileSync('git', ['-C', repo, 'bundle', 'create', join(root, 'JC-LIVE.bundle'), '--all'], { stdio: 'inherit' });
for (const name of ['evidence', 'history']) if (existsSync(join(previous, name))) cpSync(join(previous, name), join(root, name), { recursive: true });
if (existsSync(join(previous, 'DESKTOP_HANDOFF.md'))) { mkdirSync(join(root, 'history'), { recursive: true }); copyFileSync(join(previous, 'DESKTOP_HANDOFF.md'), join(root, 'history', 'DESKTOP_HANDOFF-20261020.md')); }
// Private state: consistent SQLite copy plus secrets and generated minutes.
const privateRoot = join(root, '.private'); mkdirSync(join(privateRoot, 'data'), { recursive: true });
const source = new DatabaseSync(join(repo, 'data', 'live.sqlite'), { readOnly: true });
try { source.prepare('VACUUM INTO ?').run(join(privateRoot, 'data', 'live.sqlite')); } finally { source.close(); }
const check = new DatabaseSync(join(privateRoot, 'data', 'live.sqlite'), { readOnly: true }); let counts;
try {
  if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('database copy failed integrity check');
  counts = Object.fromEntries(['streams', 'sessions', 'segments', 'events', 'corrections', 'broadcasts', 'minutes', 'ai_candidates', 'review_state']
    .map(table => [table, check.prepare('SELECT count(*) AS n FROM ' + table).get().n]));
} finally { check.close(); }
for (const name of ['access.secret', 'cloud-sync.secret']) copyFileSync(join(repo, 'data', name), join(privateRoot, 'data', name));
copyFileSync(join(repo, 'config.local.json'), join(privateRoot, 'config.local.json'));
cpSync(join(repo, 'data', 'minutes'), join(privateRoot, 'data', 'minutes'), { recursive: true });
const bsdtar = process.platform === 'win32' ? 'C:/Windows/System32/tar.exe' : 'tar';
execFileSync(bsdtar, ['-a', '-cf', join(root, 'private-state.zip'), '-C', privateRoot, 'config.local.json', 'data'], { stdio: 'inherit' });
rmSync(privateRoot, { recursive: true, force: true });
const handoff = process.env.JC_HANDOFF_FILE; if (handoff) copyFileSync(handoff, join(root, 'DESKTOP_HANDOFF.md'));
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
const files = [];
for (const path of walk(root).sort()) files.push({ path: relative(root, path).split(sep).join('/'), bytes: statSync(path).size, sha256: await sha256(path) });
const commit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
writeFileSync(join(root, 'PAYLOAD_MANIFEST.json'), JSON.stringify({ created_utc: new Date().toISOString(), commit, files }, null, 2));
const out = resolve(root, '..', 'JC-LIVE-desktop-' + stamp + '-upload'); mkdirSync(out, { recursive: true });
const archive = 'JC-LIVE-desktop-' + stamp + '.zip';
execFileSync(bsdtar, ['-a', '-cf', join(out, archive), '-C', root, ...readdirSync(root)], { stdio: 'inherit' });
execFileSync('split', ['-b', '90m', '-d', '-a', '3', '--numeric-suffixes=1', '--additional-suffix=', join(out, archive), join(out, archive + '.part')], { stdio: 'inherit' });
const parts = [];
for (const name of readdirSync(out).filter(name => name.startsWith(archive + '.part')).sort()) parts.push({ name, bytes: statSync(join(out, name)).size, sha256: await sha256(join(out, name)) });
const manifest = { created_utc: new Date().toISOString(), commit, archive: { name: archive, bytes: statSync(join(out, archive)).size, sha256: await sha256(join(out, archive)) },
  parts, payload_files: files.length, database_table_counts: counts };
writeFileSync(join(out, 'BACKUP_MANIFEST.json'), JSON.stringify(manifest, null, 2));
if (handoff) copyFileSync(handoff, join(out, 'DESKTOP_HANDOFF.md'));
rmSync(join(out, archive));
console.log(JSON.stringify({ out, archive: manifest.archive, parts: parts.map(part => [part.name, part.bytes]), payload_files: files.length, counts }));
