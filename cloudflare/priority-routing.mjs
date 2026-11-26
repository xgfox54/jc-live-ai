import { timingSafeEqual } from 'node:crypto';

// Desktop transcription has priority. The standby laptop serves viewers only while the desktop viewer listener
// does not answer, and it polls /api/failover to decide when to start (docs/LAPTOP-STANDBY.md).
const DESKTOP = 'http://127.0.0.1:4321';
// The 2026-11-11 plenary was recovered on the laptop from the official replay while the desktop was off.
// The desktop held only the part recorded before its power loss, so it must not replace the recovered
// archive or drop it from the minutes index.
export const RESTORED_MINUTES_ID = '1c7625ca6efb9f66ec5b3c96147fc13df66ff3b9832467a1c988cb36ad165695';
// On 2026-11-13 the recovered rows after the power loss became the third session of the desktop record of the same
// meeting. Once that record is published it covers the whole meeting and the recovered entry leaves the index;
// the recovered archive stays readable at its own address.
export const MERGED_MINUTES_ID = 'a6713355fc47281273206740e80a3c57d0ed1be338d13377e33250d456197f7b';
const validKey = (received, expected) => /^[a-f0-9]{64}$/.test(received ?? '') && typeof expected === 'string'
  && expected.length === 64 && timingSafeEqual(Buffer.from(received), Buffer.from(expected));

// true: the desktop engine answers. false: the desktop is unreachable or its engine is stopped. null: unknown.
// The check reads the status answer (about 1 ms on the desktop). The all-channel snapshot it read before took about 210 ms
// to build whenever its 1-second cache had expired (2026-11-21), and every viewer request waited for it.
async function desktopAvailable(env, origin) {
  if (!env.DESKTOP_LIVE) return null;
  try {
    const response = await env.DESKTOP_LIVE.fetch(new Request(DESKTOP + '/api/viewer/status?probe=1', {
      headers: { Origin: origin }, signal: AbortSignal.timeout(4000), redirect: 'manual' }));
    if (!response.ok) { await response.body?.cancel(); return response.status >= 500 ? false : null; }
    const data = await response.json();
    return data?.engine === 'running' ? true : data?.engine === 'stopped' ? false : null;
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

// Returns null when neither processor can answer. The desktop is asked together with its status check, so a viewer waits for
// one desktop round trip instead of two: on 2026-11-21 requests from Korea ran in Los Angeles, and each round trip to the
// Seoul tunnel crossed the Pacific (a 24-byte status answer took about 1 second). When the check sends the viewer to the
// laptop or finds no processor, the desktop request is cancelled.
export async function priorityFetch(path, { headers, signal }, env, origin) {
  const upstream = (base, desktop, cancel) => {
    const upstreamHeaders = new Headers(headers);
    upstreamHeaders.delete('X-JC-Laptop-Key');
    if (!desktop) upstreamHeaders.set('X-JC-Laptop-Key', env.JC_LAPTOP_SECRET);
    const limit = requestLimit(new URL(path, DESKTOP).pathname, desktop);
    const signals = [signal, cancel, limit === null ? null : AbortSignal.timeout(limit)].filter(Boolean);
    return new Request(base + path, { headers: upstreamHeaders, signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0], redirect: 'manual' });
  };
  const cancel = new AbortController();
  const desktopCall = env.DESKTOP_LIVE ? env.DESKTOP_LIVE.fetch(upstream(DESKTOP, true, cancel.signal)) : null;
  desktopCall?.catch(() => {}); // a cancelled call must not report an unhandled rejection
  const desktop = await desktopAvailable(env, origin);
  if (desktop) return relay(await desktopCall, 'desktop');
  cancel.abort();
  if (desktop === null || !env.JC_LAPTOP_URL) return null;
  return relay(await fetch(upstream(env.JC_LAPTOP_URL, false)), 'laptop');
}
function relay(response, processor) {
  const output = new Headers(response.headers);
  output.set('X-JC-Active-Processor', processor);
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

// The desktop publishes its own minutes index, which does not know the restored meeting; viewers see both
// until the merged desktop record is published.
export function archiveViewer(storage, summarize) {
  return { readView: path => storage.readView(path), saveView: (path, etag, body) => storage.saveView(path, etag, body), async read(path) {
    const row = await storage.read(path);
    if (path !== 'site.json' || !row) return row;
    if (row.value.minutes_index.some(item => item.id === MERGED_MINUTES_ID && item.session_count >= 3)) return row;
    const saved = await storage.read('minutes/' + RESTORED_MINUTES_ID + '.json');
    if (!saved) return row;
    const index = [summarize(saved.value.document), ...row.value.minutes_index.filter(item => item.id !== RESTORED_MINUTES_ID)];
    index.sort((a, b) => String(b.scheduled_at).localeCompare(String(a.scheduled_at)));
    return { ...row, etag: row.etag + ':' + saved.etag, value: { ...row.value, minutes_index: index } };
  } };
}
