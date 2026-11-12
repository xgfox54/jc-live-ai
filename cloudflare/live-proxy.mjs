import { priorityFetch } from './priority-routing.mjs';

const paths = new Set(['/api/viewer/snapshot', '/api/viewer/events', '/api/viewer/segments', '/api/viewer/schedule', '/api/viewer/status']);
const baseHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY', 'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", Vary: 'Origin' };

export async function proxyLive(request, env) {
  const url = new URL(request.url);
  if (!paths.has(url.pathname)) return null;
  const origin = request.headers.get('origin') ?? url.origin;
  let allowed;
  try { allowed = JSON.parse(env.JC_ALLOWED_ORIGINS ?? '[]'); } catch { allowed = []; }
  const headers = { ...baseHeaders };
  const reply = (error, status) => Response.json({ error }, { status, headers });
  if (!Array.isArray(allowed) || !allowed.includes(origin)) return reply('Origin denied', 403);
  headers['Access-Control-Allow-Origin'] = origin;
  headers['Access-Control-Expose-Headers'] = 'ETag, Retry-After';
  if (url.search.length > 2048) return reply('Request too long', 414);
  if (request.method === 'OPTIONS') {
    const requested = (request.headers.get('access-control-request-headers') ?? '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
    if (request.headers.get('access-control-request-method') !== 'GET' || requested.some(x => x !== 'if-none-match')) return reply('Preflight denied', 403);
    return new Response(null, { status: 204, headers: { ...headers, 'Access-Control-Allow-Methods': 'GET',
      'Access-Control-Allow-Headers': 'If-None-Match', 'Access-Control-Max-Age': '600' } });
  }
  if (request.method !== 'GET' || request.headers.has('authorization') || request.headers.has('cookie') || request.body)
    return reply('Read-only endpoint', 405);
  if (!env.DESKTOP_LIVE && !env.JC_LAPTOP_URL) return reply('데스크톱 실시간 연결을 준비하고 있습니다.', 503);
  const upstreamHeaders = new Headers({ Origin: origin });
  if (request.headers.has('if-none-match')) upstreamHeaders.set('If-None-Match', request.headers.get('if-none-match'));
  try {
    // VPC Service fixes the desktop destination to the separate loopback read-only listener. The standby laptop
    // answers only while the desktop is down (priority-routing.mjs).
    const response = await priorityFetch(url.pathname + url.search, { headers: upstreamHeaders, signal: request.signal }, env, origin);
    if (!response) return reply('데스크톱 실시간 연결을 확인하고 있습니다.', 503);
    if (response.status >= 300 && response.status < 400 && response.status !== 304) return reply('Desktop redirect rejected', 502);
    const output = new Headers(headers);
    for (const name of ['Content-Type', 'ETag', 'Retry-After', 'X-Accel-Buffering', 'X-JC-Active-Processor'])
      if (response.headers.has(name)) output.set(name, response.headers.get(name));
    return new Response(response.body, { status: response.status, headers: output });
  } catch (error) {
    console.error(JSON.stringify({ event: 'desktop.connection_failed', name: error?.name ?? 'Error',
      detail: String(error?.message ?? '').replace(/https?:\/\/\S+/g, '[endpoint]').slice(0, 250) }));
    return reply('데스크톱 실시간 연결을 확인하고 있습니다.', 503);
  }
}
