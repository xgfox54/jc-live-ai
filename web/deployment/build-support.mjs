import { mkdir, readFile, writeFile, rename, rm, cp } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, posix } from 'node:path';

export const runtime = Object.freeze({ version: '24.22.1', name: 'node-v24.22.1-linux-x64', sha256: '6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6' });
export async function runtimeArchive({ cacheDir, fetchImpl = fetch, spec = runtime }) {
  await mkdir(cacheDir, { recursive: true });
  const path = join(cacheDir, `${spec.name}-${spec.sha256}.tar.xz`);
  const valid = bytes => createHash('sha256').update(bytes).digest('hex') === spec.sha256;
  try {
    const bytes = await readFile(path);
    if (valid(bytes)) return { path, cacheHit: true };
    await rm(path);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const response = await fetchImpl(`https://nodejs.org/dist/v${spec.version}/${spec.name}.tar.xz`,
    { redirect: 'error', signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error('Official runtime download failed');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!valid(bytes)) throw new Error('Runtime checksum mismatch');
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, bytes); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
  return { path, cacheHit: false };
}

export function productionPackages(lock) {
  if (lock.lockfileVersion !== 3 || !lock.packages?.['']) throw new Error('Expected npm lockfile v3');
  const selected = new Set();
  function visit(parent, name, optional = false) {
    if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name)) throw new Error('Invalid package name');
    let base = parent;
    let key;
    while (true) {
      const candidate = (base ? base + '/' : '') + 'node_modules/' + name;
      if (lock.packages[candidate]) { key = candidate; break; }
      if (!base) break;
      const index = base.lastIndexOf('/node_modules/');
      base = index < 0 ? '' : base.slice(0, index);
    }
    if (!key) { if (optional) return; throw new Error(`Missing locked dependency: ${name}`); }
    if (selected.has(key)) return;
    const entry = lock.packages[key];
    if (entry.link || entry.dev) throw new Error(`Invalid production package: ${key}`);
    selected.add(key);
    for (const dependency of Object.keys(entry.dependencies || {})) visit(key, dependency, dependency in (entry.optionalDependencies || {}));
    for (const dependency of Object.keys(entry.optionalDependencies || {})) visit(key, dependency, true);
    for (const dependency of Object.keys(entry.peerDependencies || {})) visit(key, dependency, entry.peerDependenciesMeta?.[dependency]?.optional === true);
  }
  const root = lock.packages[''];
  for (const name of Object.keys(root.dependencies || {})) visit('', name);
  for (const name of Object.keys(root.optionalDependencies || {})) visit('', name, true);
  return [...selected].sort();
}

export async function copyProductionPackages(root, destination, lock) {
  const packages = productionPackages(lock);
  for (const key of packages) {
    const source = join(root, key);
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    if (manifest.version !== lock.packages[key].version) throw new Error(`Installed version differs from lock: ${key}`);
    await mkdir(join(destination, posix.dirname(key)), { recursive: true });
    await cp(source, join(destination, key), { recursive: true, filter: path => path === source || !path.slice(source.length + 1).split(/[\\/]/).includes('node_modules') });
  }
  return packages;
}

export function headerPattern(source) {
  if (source === '/(.*)') return '^/(.*)$';
  if (source === '/api/:path*') return '^/api(?:/(.*))?$';
  if (/^\/[a-zA-Z0-9_./-]*$/.test(source)) return '^' + source.replace(/[.]/g, '\\.') + '$';
  throw new Error(`Unsupported header source: ${source}`);
}

export function generateConfig(source) {
  const headers = (source.headers || []).map(rule => {
    if (Object.keys(rule).some(key => !['source', 'headers'].includes(key))) throw new Error('Unsupported header condition');
    return { src: headerPattern(rule.source), headers: Object.fromEntries(rule.headers.map(header => [header.key, header.value])), continue: true };
  });
  return { version: 3, cache: ['.vercel/cache/runtime/**'], routes: [
    ...headers,
    { src: '^/$', dest: '/index.html' },
    { src: '^/minutes$', dest: '/minutes.html' },
    { src: '^/api/viewer/(.*)$', dest: '/api/viewer?route=$1' },
    { handle: 'filesystem' },
    { src: '/(.*)', status: 404, headers: { 'Cache-Control': 'no-store' } },
  ] };
}

