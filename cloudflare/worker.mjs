import { syncRequest, viewerRequest } from '../web/lib/http-core.mjs';
import { CloudError, minutesSummary } from '../web/lib/model.mjs';
import { D1Store } from './d1-store.mjs';
import { proxyLive } from './live-proxy.mjs';
import { priorityControl, protectedArchive, archiveViewer } from './priority-routing.mjs';
import { handoffRequest } from './handoff.mjs';

const stores = new WeakMap();
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  'Cache-Control': 'no-store',
};
const error = (message, status) => Response.json({ error: message }, { status, headers: securityHeaders });

export function archiveOnly(value) {
  if (!value.publication) throw new CloudError(400, 'Publication protocol required', 'invalid');
  if (value.kind === 'minutes') {
    if (value.document.status !== 'draft') throw new CloudError(400, 'Only ended meeting archives are accepted', 'invalid');
  } else if (['streams', 'segments', 'live_segments', 'live_pending', 'states', 'health', 'gaps'].some(key => value.snapshot[key]?.length)
    || value.snapshot.event_id !== 0 || value.snapshot.schedule
    || value.minutes_index.some(item => item.status !== 'draft'))
    throw new CloudError(400, 'Live data must remain on desktop', 'invalid');
}

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname.length > 2048 || url.search.length > 2048) return error('Request too long', 414);
  if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
  // Laptop standby control and shared transcription progress; each requires its own key.
  if (url.pathname === '/api/failover') return priorityControl(request, env);
  if (url.pathname === '/api/handoff') return handoffRequest(request, env);
  const live = await proxyLive(request, env);
  if (live) return live;
  const sync = url.pathname === '/api/sync';
  const route = url.pathname.replace(/^\/api\/viewer\/?/, '');
  const minutes = url.pathname.startsWith('/api/viewer/') && /^(?:minutes\/?|minutes\/[a-f0-9]{64}(?:\.(?:md|json))?)$/.test(route);
  if (!sync && !minutes) return error('Route not found', 404);
  if (url.search || request.headers.has('cookie')) return error('Request rejected', 400);
  if (!env.DB || !/^[a-f0-9]{64}$/.test(env.JC_SYNC_SECRET ?? '')
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(env.JC_PUBLISHER_ID ?? ''))
    return error('Archive service is not configured', 503);
  // One wrapper pair per database keeps the viewer model cache, which is keyed by the storage object.
  if (!stores.has(env.DB)) {
    const store = new D1Store(env.DB);
    stores.set(env.DB, { sync: protectedArchive(store), viewer: archiveViewer(store, minutesSummary) });
  }
  const storage = stores.get(env.DB);
  const response = sync
    ? await syncRequest(request, { storage: storage.sync, secret: env.JC_SYNC_SECRET, publisherId: env.JC_PUBLISHER_ID, validate: archiveOnly })
    : await viewerRequest(request, { storage: storage.viewer });
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(securityHeaders)) if (!headers.has(key)) headers.set(key, value);
  headers.delete('Vercel-CDN-Cache-Control');
  return new Response(response.body, { status: response.status, headers, encodeBody: 'manual' });
}

export default { fetch: handleRequest };
