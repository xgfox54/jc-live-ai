import { timingSafeEqual } from 'node:crypto';

// Desktop transcription has priority. The standby laptop serves viewers only while the desktop viewer listener
// does not answer, and it polls /api/failover to decide when to start (docs/LAPTOP-STANDBY.md).
const DESKTOP = 'http://127.0.0.1:4321';
// The 2026-11-11 plenary was recovered on the laptop from the official replay while the desktop was off.
// The desktop holds only the part recorded before its power loss, so it must not replace the recovered
// archive or drop it from the minutes index.
export const RESTORED_MINUTES_ID = '1c7625ca6efb9f66ec5b3c96147fc13df66ff3b9832467a1c988cb36ad165695';
const validKey = (received, expected) => /^[a-f0-9]{64}$/.test(received ?? '') && typeof expected === 'string'
  && expected.length === 64 && timingSafeEqual(Buffer.from(received), Buffer.from(expected));

// true: the desktop engine answers. false: the desktop is unreachable or its engine is stopped. null: unknown.
export async function desktopAvailable(env, origin) {
  if (!env.DESKTOP_LIVE) return null;
  try {
    const response = await env.DESKTOP_LIVE.fetch(new Request(DESKTOP + '/api/viewer/snapshot?text_streams=', {
      headers: { Origin: origin }, signal: AbortSignal.timeout(4000), redirect: 'manual' }));
    if (!response.ok) { await response.body?.cancel(); return response.status >= 500 ? false : null; }
    const data = await response.json();
    if (!Array.isArray(data.streams) || !Array.isArray(data.states)) return null;
    return data.engine !== 'stopped';
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return error instanceof SyntaxError ? null : false;
  }
}

// Read by the laptop standby controller with the laptop key; it never reaches viewers.
export async function priorityControl(request, env) {
  if (request.method !== 'GET' || !validKey(request.headers.get('X-JC-Laptop-Key'), env.JC_LAPTOP_SECRET))
    return new Response(null, { status: 403 });
  return Response.json({ desktop_ready: await desktopAvailable(env, new URL(request.url).origin), checked_ms: Date.now(),
    poll_ms: 15000, silence_ms: 60000 }, { headers: { 'Cache-Control': 'no-store' } });
}

// Event streams served by the laptop end after 30 seconds so a recovered desktop takes those viewers back.
// Desktop streams stay open: reconnecting every viewer each 30 seconds would multiply Worker requests.
export function requestLimit(pathname, desktop) {
  return pathname.endsWith('/events') ? (desktop ? null : 30000) : 15000;
}

// Returns null when neither processor can answer.
export async function priorityFetch(path, { headers, signal }, env, origin) {
  const desktop = await desktopAvailable(env, origin);
  if (desktop === null || (!desktop && !env.JC_LAPTOP_URL)) return null;
  const upstreamHeaders = new Headers(headers);
  upstreamHeaders.delete('X-JC-Laptop-Key');
  if (!desktop) upstreamHeaders.set('X-JC-Laptop-Key', env.JC_LAPTOP_SECRET);
  const limit = requestLimit(new URL(path, DESKTOP).pathname, desktop);
  const signals = [signal, limit === null ? null : AbortSignal.timeout(limit)].filter(Boolean);
  const upstream = new Request((desktop ? DESKTOP : env.JC_LAPTOP_URL) + path, { headers: upstreamHeaders,
    signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0], redirect: 'manual' });
  const response = desktop ? await env.DESKTOP_LIVE.fetch(upstream) : await fetch(upstream);
  const output = new Headers(response.headers);
  output.set('X-JC-Active-Processor', desktop ? 'desktop' : 'laptop');
  return new Response(response.body, { status: response.status, headers: output });
}

// A replacement of the restored archive is accepted only when it keeps every recovered segment together
// with the recovered summary. Other meetings are published as before.
export function protectedArchive(storage) {
  return {
    read: path => storage.read(path),
    async write(path, value, etag) {
      if (path === 'minutes/' + RESTORED_MINUTES_ID + '.json') {
        const previous = await storage.read(path);
        if (previous) {
          const ids = new Set(value.document.transcript.map(row => row.segment_id));
          if (previous.value.document.transcript.some(row => !ids.has(row.segment_id))
            || !value.document.digest?.topics?.length || !value.document.timeline?.length) {
            const error = new Error('Recovered archive must be reconciled before replacement');
            error.name = 'PublicationConflict'; throw error;
          }
        }
      }
      return storage.write(path, value, etag);
    }
  };
}

// The desktop publishes its own minutes index, which does not know the restored meeting; viewers see both.
export function archiveViewer(storage, summarize) {
  return { async read(path) {
    const row = await storage.read(path);
    if (path !== 'site.json' || !row) return row;
    const saved = await storage.read('minutes/' + RESTORED_MINUTES_ID + '.json');
    if (!saved) return row;
    const index = [summarize(saved.value.document), ...row.value.minutes_index.filter(item => item.id !== RESTORED_MINUTES_ID)];
    index.sort((a, b) => String(b.scheduled_at).localeCompare(String(a.scheduled_at)));
    return { ...row, etag: row.etag + ':' + saved.etag, value: { ...row.value, minutes_index: index } };
  } };
}
