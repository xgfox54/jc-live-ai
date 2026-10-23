import { syncRequest, viewerRequest } from '../lib/http.mjs';
import { assertSupportedRuntime } from '../lib/runtime.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';

const context = new AsyncLocalStorage();
globalThis[Symbol.for('@vercel/request-context')] = { get: () => context.getStore() };

export async function handleEvent(event, options) {
  assertSupportedRuntime();
  const input = JSON.parse(event.body);
  if (typeof input.host !== 'string' || !/^[a-z0-9.-]+(?::\d+)?$/i.test(input.host)
    || typeof input.path !== 'string' || !input.path.startsWith('/') || input.path.startsWith('//')
    || /[\\\r\n]/.test(input.path)) throw new Error('Invalid proxy request');
  const headers = new Headers();
  let oidcToken;
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    if (key.toLowerCase() === 'x-vercel-oidc-token') {
      if (typeof value === 'string') oidcToken = value;
    } else if (!key.toLowerCase().startsWith('x-vercel-internal-'))
      headers.set(key, Array.isArray(value) ? value.join(', ') : String(value));
  }
  if (input.encoding && input.encoding !== 'base64') throw new Error('Invalid proxy encoding');
  if (input.body != null && (typeof input.body !== 'string' || input.body.length > 4_700_000))
    return encode(Response.json({ error: 'Request too large' }, { status: 413 }));
  const body = input.body == null ? undefined : Buffer.from(input.body, input.encoding === 'base64' ? 'base64' : 'utf8');
  if (body?.length > 3_500_000) return encode(Response.json({ error: 'Request too large' }, { status: 413 }));
  const request = new Request('https://' + input.host + input.path, {
    method: input.method, headers, ...(!['GET', 'HEAD'].includes(input.method) && body ? { body } : {}),
  });
  const path = new URL(request.url).pathname;
  // Vercel injects this short-lived token into its trusted invocation envelope.
  // Keep it request-scoped for the Blob SDK; never put it in process.env or responses.
  return context.run({ headers: oidcToken ? { 'x-vercel-oidc-token': oidcToken } : {} }, async () => {
    const response = path === '/api/sync' ? await syncRequest(request, options)
      : path === '/api/viewer' || path.startsWith('/api/viewer/') ? await viewerRequest(request, options)
        : Response.json({ error: 'Not found' }, { status: 404 });
    return encode(response);
  });
}

async function encode(response) {
  return { statusCode: response.status, headers: Object.fromEntries(response.headers),
    body: Buffer.from(await response.arrayBuffer()).toString('base64'), encoding: 'base64' };
}
