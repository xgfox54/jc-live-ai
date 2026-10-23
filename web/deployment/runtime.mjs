import { request } from 'node:http';
import { handleEvent } from './handler.mjs';
import { assertSupportedRuntime } from '../lib/runtime.mjs';

assertSupportedRuntime();
const endpoint = process.env.AWS_LAMBDA_RUNTIME_API;
if (!endpoint || !/^[a-zA-Z0-9.-]+:\d+$/.test(endpoint)) throw new Error('Runtime API unavailable');
console.info(JSON.stringify({ event: 'runtime.ready', node: process.versions.node, openssl: process.versions.openssl }));

function exchange(path, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const req = request('http://' + endpoint + '/2018-06-01/runtime/' + path, {
      method, headers: body ? { 'Content-Type': 'application/json' } : {},
    }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 6_500_000) res.destroy(new Error('Invocation exceeds limit'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => res.statusCode >= 200 && res.statusCode < 300
        ? resolve({ headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
        : reject(new Error('Runtime API rejected invocation')));
    });
    req.on('error', reject);
    req.end(body);
  });
}

while (true) {
  const next = await exchange('invocation/next');
  const id = next.headers['lambda-runtime-aws-request-id'];
  if (typeof id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('Invalid invocation identifier');
  try {
    const response = await handleEvent(JSON.parse(next.body));
    await exchange('invocation/' + id + '/response', 'POST', JSON.stringify(response));
  } catch {
    console.error(JSON.stringify({ event: 'runtime.invocation_failed', requestId: id }));
    await exchange('invocation/' + id + '/error', 'POST',
      JSON.stringify({ errorMessage: 'Request processing failed', errorType: 'InvocationError' }));
  }
}
