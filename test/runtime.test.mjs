import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { brotliCompressSync } from 'node:zlib';
import { assertSupportedRuntime } from '../web/lib/runtime.mjs';

test('runtime rejects vulnerable, unsupported and prerelease versions', () => {
  for (const version of ['24.18.0', '24.22.0', '23.99.99', '25.0.0', '24.22.1-rc.1', 'invalid']) {
    assert.throws(() => assertSupportedRuntime(version), /requires Node.js/);
  }
  for (const version of ['24.22.1', '24.22.2', '24.23.0']) assert.doesNotThrow(() => assertSupportedRuntime(version));
});

test('unsupported runtime stops local startup before config access', () => {
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    Object.defineProperty(process.versions, 'node', {value:'24.22.0'});
    process.argv[2] = 'nonexistent-runtime-test-config.json';
    try { await import('./src/main.mjs'); process.exitCode = 1; }
    catch (error) { if (!error.message.includes('requires Node.js')) throw error; console.log('blocked'); }
  `], { cwd: new URL('../', import.meta.url), encoding: 'utf8' });
  assert.match(output, /blocked/);
});

test('unsupported runtime blocks service factory and cloud storage access', () => {
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {createService} from './src/server.mjs';
    import {viewerRequest, syncRequest} from './web/lib/http.mjs';
    Object.defineProperty(process.versions, 'node', {value:'24.22.0'});
    assert.throws(() => createService({}), /requires Node.js/);
    let reads = 0;
    const storage = {read() { reads++; throw Error('unexpected storage access'); }};
    for (const handler of [viewerRequest, syncRequest]) {
      const response = await handler(new Request('https://example.test/api'), {storage});
      assert.equal(response.status, 503);
      assert.doesNotMatch(await response.text(), /24\\.22|runtime/);
    }
    assert.equal(reads, 0); console.log('blocked');
  `], { cwd: new URL('../', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(output, /blocked/);
});

test('patched fetch decodes a legitimate Brotli response', async () => {
  assertSupportedRuntime();
  const text = '제주도의회 회의록 받아쓰기';
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Encoding': 'br', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(brotliCompressSync(Buffer.from(text)));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { assert.equal(await (await fetch('http://127.0.0.1:' + server.address().port)).text(), text); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
