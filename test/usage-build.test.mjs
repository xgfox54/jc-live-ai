import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { runtimeArchive, productionPackages, copyProductionPackages, generateConfig, headerPattern } from '../web/deployment/build-support.mjs';
import { build } from '../web/deployment/build.mjs';
import { classifyRelease, inspectRelease, ignoredBuildExitCode } from '../scripts/release-impact.mjs';

const root = new URL('../', import.meta.url);
async function temporary(t) {
  const path = await mkdtemp(join(tmpdir(), 'jc-build-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
const bytes = Buffer.from('offline archive fixture');
const spec = { version: '24.22.1', name: 'node-v24.22.1-linux-x64', sha256: createHash('sha256').update(bytes).digest('hex') };
for (const mode of ['cold', 'warm', 'corrupt']) test(`runtime cache verifies ${mode} archive without network`, async t => {
  const cacheDir = await temporary(t);
  const path = join(cacheDir, `${spec.name}-${spec.sha256}.tar.xz`);
  if (mode !== 'cold') await writeFile(path, mode === 'warm' ? bytes : 'corrupt');
  let downloads = 0;
  const result = await runtimeArchive({ cacheDir, spec, fetchImpl: async () => { downloads++; return { ok: true, arrayBuffer: async () => bytes }; } });
  assert.equal(downloads, mode === 'warm' ? 0 : 1);
  assert.equal(result.cacheHit, mode === 'warm');
  assert.deepEqual(await readFile(result.path), bytes);
  assert.deepEqual(await readdir(cacheDir), [path.split(/[\\/]/).at(-1)]);
});
test('checksum failure leaves no usable archive or temporary file', async t => {
  const cacheDir = await temporary(t);
  await assert.rejects(runtimeArchive({ cacheDir, spec, fetchImpl: async () => ({ ok: true, arrayBuffer: async () => Buffer.from('bad') }) }), /checksum/);
  assert.deepEqual(await readdir(cacheDir), []);
});
test('header rules retain all source entries in order and route cache boundaries', async () => {
  const source = JSON.parse(await readFile(new URL('../web/vercel.json', import.meta.url), 'utf8'));
  const assets = JSON.parse(await readFile(new URL('../web/deployment/public-assets.json', import.meta.url), 'utf8'));
  const config = generateConfig(source);
  assert.deepEqual(config.routes.slice(0, source.headers.length), source.headers.map(rule => ({ src: headerPattern(rule.source), headers: Object.fromEntries(rule.headers.map(h => [h.key, h.value])), continue: true })));
  const headersFor = path => Object.assign({}, ...config.routes.filter(r => r.continue && new RegExp(r.src).test(path)).map(r => r.headers));
  for (const path of ['/', '/minutes', ...assets.map(a => '/' + a)]) assert.equal(headersFor(path)['Cache-Control'], 'no-cache, must-revalidate');
  for (const path of ['/api/viewer', '/api/viewer/minutes', '/api/sync', '/missing']) {
    assert.equal(headersFor(path)['Cache-Control'], 'no-store');
    assert.equal(headersFor(path)['X-Frame-Options'], 'DENY');
    assert.ok(headersFor(path)['Content-Security-Policy']);
  }
  assert.ok(config.routes.some(r => r.src === '^/$' && r.dest === '/index.html'));
  assert.ok(config.routes.some(r => r.src === '^/minutes$' && r.dest === '/minutes.html'));
  assert.ok(config.routes.some(r => r.dest === '/api/viewer?route=$1'));
  assert.deepEqual(config.routes.at(-2), { handle: 'filesystem' });
  assert.equal(config.routes.at(-1).status, 404);
  if (process.env.JC_BUILD_EVIDENCE) await writeFile(join(process.env.JC_BUILD_EVIDENCE, 'generated-config.json'), JSON.stringify(config, null, 2));
  assert.throws(() => generateConfig({ headers: [{ source: '/:unsupported+', headers: [] }] }), /Unsupported/);
  assert.throws(() => generateConfig({ headers: [{ source: '/', headers: [], has: [] }] }), /Unsupported/);
});
test('lock closure preserves transitive and nested dependencies without dev packages', () => {
  const lock = { lockfileVersion: 3, packages: { '': { dependencies: { a: '1' } }, 'node_modules/a': { dependencies: { b: '1' } }, 'node_modules/a/node_modules/b': {}, 'node_modules/dev': { dev: true } } };
  assert.deepEqual(productionPackages(lock), ['node_modules/a', 'node_modules/a/node_modules/b']);
  delete lock.packages['node_modules/a/node_modules/b'];
  assert.throws(() => productionPackages(lock), /Missing locked/);
});
async function size(path) {
  const entries = await readdir(path, { withFileTypes: true });
  let bytes = 0; let files = 0;
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) { const nested = await size(child); bytes += nested.bytes; files += nested.files; }
    else { bytes += (await stat(child)).size; files++; }
  }
  return { bytes, files };
}
test('installed production package copy retains Blob and OIDC imports and license files', async t => {
  const destination = await temporary(t);
  const web = new URL('../web/', import.meta.url);
  const lock = JSON.parse(await readFile(new URL('package-lock.json', web), 'utf8'));
  const packages = await copyProductionPackages(fileURLToPath(web), destination, lock);
  assert.ok(packages.includes('node_modules/@vercel/oidc'));
  const blob = await import(pathToFileURL(join(destination, 'node_modules/@vercel/blob/dist/index.js')));
  assert.equal(typeof blob.put, 'function');
  const oidcManifest = JSON.parse(await readFile(join(destination, 'node_modules/@vercel/oidc/package.json'), 'utf8'));
  assert.ok(oidcManifest.exports);
  const oidc = await import(pathToFileURL(join(destination, 'node_modules/@vercel/oidc/dist/index.js')));
  assert.equal(typeof oidc.getVercelOidcToken, 'function');
  for (const packagePath of packages) {
    const original = new URL(packagePath + '/', web);
    const licenses = (await readdir(original)).filter(name => /^(licen[cs]e|copying|notice)/i.test(name));
    for (const name of licenses) assert.deepEqual(await readFile(join(destination, packagePath, name)), await readFile(new URL(name, original)));
  }
  const before = await size(fileURLToPath(new URL('node_modules/', web)));
  const after = await size(join(destination, 'node_modules'));
  assert.ok(after.bytes <= before.bytes);
  if (process.env.JC_BUILD_EVIDENCE) {
    await mkdir(process.env.JC_BUILD_EVIDENCE, { recursive: true });
    await writeFile(join(process.env.JC_BUILD_EVIDENCE, 'dependency-size.json'), JSON.stringify({ before, after, packages, linuxRuntimeExecuted: false }, null, 2));
  }
});
test('release classifier uses successful deployment base and builds on unavailable history', () => {
  for (const file of ['public/app.mjs', 'web/lib/storage.mjs', 'scripts/build-web.mjs', 'package-lock.json', 'web/package-lock.json', 'src/shared.mjs', 'runtime/node', 'unknown-file']) assert.equal(classifyRelease({ base: 'a', files: [file] }).build, true);
  assert.equal(classifyRelease({ base: 'a', files: ['docs/guide.md', 'test/core.test.mjs'] }).build, false);
  assert.equal(classifyRelease({ files: ['docs/guide.md'] }).build, true);
  assert.equal(classifyRelease({ base: 'a', shallow: true, files: [] }).build, true);
  assert.equal(inspectRelease({ base: 'a'.repeat(40), run: () => { throw new Error('unknown'); } }).build, true);
  const calls = [];
  const result = inspectRelease({ base: 'a'.repeat(40), run: (cmd, args) => { calls.push(args); return args[0] === 'rev-parse' ? 'false' : args[0] === 'diff' ? 'docs/guide.md\0' : ''; } });
  assert.equal(result.build, false);
  assert.equal(ignoredBuildExitCode(result), 0);
  assert.equal(ignoredBuildExitCode({ build: true }), 1);
  assert.equal(inspectRelease({ base: 'a'.repeat(40), run: (cmd, args) => args[0] === 'rev-parse' ? 'false' : args[0] === 'status' ? ' M public/app.mjs' : '' }).reason, 'uncommitted-changes');
  assert.ok(calls.some(args => args[0] === 'diff' && args.includes('a'.repeat(40))));
});
test('ignored step exits one when a successful deployment base is missing', () => {
  const result = spawnSync(process.execPath, ['scripts/release-impact.mjs', '--ignored-build-step'], { cwd: root, env: { ...process.env, VERCEL_GIT_PREVIOUS_SHA: '' }, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).build, true);
});
test('build import is safe and non-Linux build fails before download', async () => {
  if (process.platform === 'linux' && process.arch === 'x64') return;
  await assert.rejects(build({ fetchImpl: () => { throw new Error('network invoked'); } }), /Linux x64/);
});


