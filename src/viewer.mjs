import { EventFeed } from './events.mjs';
import { HttpError, identifier, integer } from './validate.mjs';
import { minutesRequest } from './minutes-http.mjs';
import { CHANNEL_IDS } from '../public/committees.mjs';
import { viewerMinutesRegistry } from './viewer-minutes.mjs';
import { publicSpeech, suspectText, publicText } from './silence-filter.mjs';
import { deliveryHealth } from './delivery-health.mjs';
import { selectSnapshotText, snapshotEtag, matchesEtag } from '../web/lib/snapshot-selection.mjs';
import { minutesPage } from '../web/lib/model.mjs';
import { brotliCompress, gzip, constants as zlib } from 'node:zlib';
import { promisify } from 'node:util';

const brotliAsync = promisify(brotliCompress); const gzipAsync = promisify(gzip);
// Viewer answers of 1 KB or more go out compressed when the caller accepts it (browsers, and the Cloudflare Worker, which
// passes the compressed body on unchanged). Brotli quality 5 turned the 1,678-sentence record of 19 November (832 KB) into
// 137 KB in about 8 ms on the desktop (2026-11-21); gzip level 6 gave 157 KB. The answers hold public data only.
export function acceptedEncoding(header) {
  const accepted = new Set();
  for (const part of String(header ?? '').toLowerCase().split(',')) {
    const [name, ...params] = part.split(';').map(value => value.trim());
    if (name && !params.some(param => /^q=0(?:\.0{0,3})?$/.test(param))) accepted.add(name);
  }
  return accepted.has('br') ? 'br' : accepted.has('gzip') ? 'gzip' : null;
}
function encodeText(text, encoding) {
  const body = Buffer.from(text);
  return encoding === 'br' ? brotliAsync(body, { params: { [zlib.BROTLI_PARAM_QUALITY]: 5, [zlib.BROTLI_PARAM_MODE]: zlib.BROTLI_MODE_TEXT,
    [zlib.BROTLI_PARAM_SIZE_HINT]: body.length } }) : gzipAsync(body, { level: 6 });
}
// `encoded` holds one compression per encoding, shared by every viewer of a cached answer. A failed compression sends the text.
function sendJson(req, res, headers, text, encoded = new Map()) {
  const base = { 'Content-Type': 'application/json; charset=utf-8', Vary: 'Origin, Accept-Encoding', ...headers };
  const encoding = text.length >= 1024 ? acceptedEncoding(req.headers['accept-encoding']) : null;
  if (!encoding) { res.writeHead(200, base); res.end(text); return; }
  if (!encoded.has(encoding)) encoded.set(encoding, encodeText(text, encoding));
  encoded.get(encoding).then(body => {
    if (res.destroyed || res.headersSent) return;
    res.writeHead(200, { ...base, 'Content-Encoding': encoding, 'Content-Length': body.length }); res.end(body);
  }, () => {
    encoded.delete(encoding);
    if (res.destroyed || res.headersSent) return;
    res.writeHead(200, base); res.end(text);
  });
}

// 'running' while this process's transcription worker accepts audio. The read-only viewer process has no engine,
// and a stopping or restarting worker is not ready, so both report 'stopped'.
export const engineStatus = scheduler => scheduler.accepting === true && scheduler.engine?.ready === true ? 'running' : 'stopped';

function publicBroadcastFilter(store, sessionExpression) {
  const tables = store.db.prepare("SELECT count(*) AS total FROM sqlite_master WHERE type='table' AND name IN ('broadcasts','broadcast_sessions')").get();
  if (tables.total !== 2) return '';
  return `AND NOT EXISTS (SELECT 1 FROM broadcast_sessions bs JOIN broadcasts b ON b.id=bs.broadcast_id
    WHERE bs.session_id=${sessionExpression} AND json_type(b.document,'$.test_run')='true')`;
}
function publicSession(store, value) {
  if (value.test_run === true) return false;
  if (!value.session_id) return true;
  if (store.db.prepare("SELECT 1 FROM sessions WHERE id=? AND json_type(document,'$.test_run')='true'").get(value.session_id)) return false;
  const filter = publicBroadcastFilter(store, '?');
  return !filter || Boolean(store.db.prepare(`SELECT 1 WHERE 1=1 ${filter}`).get(value.session_id));
}
function publicSegments(store, query) {
  const limit = query.limit ?? 100;
  let before = query.before ?? Number.MAX_SAFE_INTEGER;
  let items = [];
  // A page holds the sentences of a few sessions, and each session is checked once. Checking every row took 54 of 75 ms
  // for the whole record of a meeting (1,679 sentences, 2026-11-21).
  const sessions = new Map();
  const visible = row => {
    if (row.test_run === true || !row.session_id) return publicSession(store, row);
    if (!sessions.has(row.session_id)) sessions.set(row.session_id, publicSession(store, { session_id: row.session_id }));
    return sessions.get(row.session_id);
  };
  while (items.length < limit) {
    const remaining = limit - items.length;
    const page = store.segments({ ...query, before, limit: remaining });
    // Rows hidden as silence artifacts do not fill the page, so a long recess cannot push earlier sentences out of it.
    items = [...page.items.filter(row => visible(row) && publicSpeech(row)), ...items];
    before = page.before;
    if (page.items.length < remaining) break;
  }
  return { items, before: before ?? 0 };
}
function publicLiveSegments(store, stream, broadcast) {
  return store.db.prepare(`SELECT rowid,document FROM segments WHERE stream_id=? AND json_extract(document,'$.live_preview')=1
    AND NOT EXISTS (SELECT 1 FROM sessions WHERE sessions.id=segments.session_id AND json_type(sessions.document,'$.test_run')='true')
    ${publicBroadcastFilter(store, 'segments.session_id')}
    ${broadcast ? 'AND session_id IN (SELECT session_id FROM broadcast_sessions WHERE broadcast_id=?)' : ''}
    ORDER BY json_extract(document,'$.preview_updated_ms') DESC,rowid DESC LIMIT 200`)
    .all(stream, ...(broadcast ? [broadcast] : [])).map(row => ({ ...JSON.parse(row.document), sequence: row.rowid }));
}
function pendingManifest(store, stream, broadcast) {
  const rows = store.db.prepare(`SELECT document FROM segments WHERE stream_id=?
    AND json_extract(document,'$.live_preview')=1 AND json_extract(document,'$.ai_corrected')=0
    AND NOT EXISTS (SELECT 1 FROM sessions WHERE sessions.id=segments.session_id AND json_type(sessions.document,'$.test_run')='true')
    ${publicBroadcastFilter(store, 'segments.session_id')}
    ${broadcast ? 'AND session_id IN (SELECT session_id FROM broadcast_sessions WHERE broadcast_id=?)' : ''}
    ORDER BY rowid LIMIT 10001`).all(stream, ...(broadcast ? [broadcast] : []));
  return { stream_id: stream, broadcast_id: broadcast ?? null, complete: rows.length <= 10000,
    segment_ids: rows.slice(0, 10000).map(row => JSON.parse(row.document))
      .filter(row => publicSession(store, row) && viewerLiveSegment(row)?.display_state === 'draft').map(row => row.segment_id) };
}

export function viewerStream(stream) {
  if (stream.deleted) return { stream_id: stream.stream_id, deleted: true };
  const { stream_id, name, page_url, video_id, broadcast_id } = stream;
  return { stream_id, name, page_url, video_id, broadcast_id };
}
export function viewerState(state) {
  const { stream_id, session_id, timeline_epoch, state: status, started_ms, last_receive_ms } = state;
  return { stream_id, session_id, timeline_epoch, state: status, started_ms, last_receive_ms, partial: null };
}
export function viewerGap(gap) {
  const { stream_id, session_id, timeline_epoch, start_ms, end_ms } = gap;
  return { stream_id, session_id, timeline_epoch, start_ms, end_ms };
}
function displayTimes(segment) {
  return Number.isFinite(segment.video_offset_ms) ? { start_ms: segment.start_ms + segment.video_offset_ms, end_ms: segment.end_ms + segment.video_offset_ms } : {};
}
export function viewerSegment(segment) {
  if (segment.ai_corrected !== true || typeof segment.corrected_text !== 'string' || !segment.corrected_text.trim()) return null;
  if (!publicSpeech(segment)) return null;
  const { stream_id, session_id, timeline_epoch, segment_id, start_ms, end_ms,
    corrected_text, version, speaker_id } = segment;
  return { stream_id, session_id, timeline_epoch, segment_id, start_ms, end_ms, ...displayTimes(segment), text: publicText(corrected_text),
    sequence: Number.isSafeInteger(segment.sequence) && segment.sequence > 0 ? segment.sequence : null,
    audio_received_ms: Number.isSafeInteger(segment.audio_received_ms) && segment.audio_received_ms > 0 ? segment.audio_received_ms : null,
    ai_corrected: true, version, speaker_id: speaker_id ?? null,
    ...(segment.speaker_state ? { speaker_scope: segment.speaker_scope ?? null, speaker_state: segment.speaker_state,
      speaker_ids: [...new Set((segment.speaker_turns ?? []).filter(turn => turn.end_ms - turn.start_ms >= 200).map(turn => turn.speaker_id))] } : {}) };
}
export function viewerLiveSegment(segment) {
  if (segment.live_preview !== true) return null;
  const corrected = viewerSegment(segment);
  if (corrected) return { ...corrected, display_state: 'corrected' };
  // A phrase Whisper also produces over silence ("감사합니다.", "MBC 뉴스 …입니다") is shown only after the speaker check.
  const waiting = segment.speaker_state === 'pending' && suspectText(segment.raw_text);
  const draft = !waiting && segment.ai_corrected !== true && typeof segment.raw_text === 'string' && segment.raw_text.trim()
    && publicSpeech({ ...segment, corrected_text: null });
  const { stream_id, session_id, segment_id, timeline_epoch = 0, start_ms, end_ms, version } = segment;
  return { stream_id, session_id, segment_id, timeline_epoch, start_ms, end_ms, ...displayTimes(segment), version,
    sequence: segment.sequence ?? null, audio_received_ms: segment.audio_received_ms ?? null,
    text: draft ? publicText(segment.raw_text).slice(0, 5000) : '', ai_corrected: false,
    display_state: draft ? 'draft' : 'removed', speaker_id: segment.speaker_id ?? null };
}
function viewerEvent(event, context) {
  const { store, registry } = context;
  if (!publicSession(store, event.payload)) return null;
  let payload = {};
  switch (event.kind) {
    case 'delivery-health': return event;
    case 'stream': payload = viewerStream(event.payload); break;
    case 'session': case 'status': payload = viewerState(event.payload); break;
    case 'gap': payload = viewerGap(event.payload); break;
    case 'segment': {
      const stream = store.streams().find(item => item.stream_id === event.payload.stream_id);
      if (stream?.broadcast_id && registry?.forSession(event.payload.session_id) !== stream.broadcast_id) return null;
      const segment = { ...event.payload, sequence: store.db.prepare('SELECT rowid AS sequence FROM segments WHERE id=?').get(event.payload.segment_id)?.sequence };
      payload = viewerLiveSegment(segment);
      if (payload) return { event_id: event.event_id, kind: 'live-segment', payload };
      payload = viewerSegment(segment); if (!payload) return null; break;
    }
    case 'partial': return null;
  }
  return { event_id: event.event_id, kind: event.kind, payload };
}
// Sentences (published pages, live previews and their pending lists) are built only for the channels in `texts`; streams,
// states, gaps and health cover every channel in `ids`. Building sentences for all 13 channels took about 200 ms on the
// desktop even when a request asked for none (2026-11-21).
export function viewerSnapshot(context, ids, texts = ids) {
  const { store, scheduler, registry } = context;
  const textIds = ids.filter(id => texts.includes(id));
  const broadcasts = Object.fromEntries(store.streams().filter(stream => stream.broadcast_id).map(stream => [stream.stream_id, stream.broadcast_id]));
  const belongs = value => publicSession(store, value)
    && (!broadcasts[value.stream_id] || registry?.forSession(value.session_id) === broadcasts[value.stream_id]);
  const snapshot = store.snapshot(ids, broadcasts, true, []);
  const pages = textIds.map(stream => ({ stream, ...publicSegments(store, { stream, broadcast: broadcasts[stream], published: true }) }));
  const states = [...new Map([...store.states(), ...scheduler.states()].map(s => [s.stream_id, s])).values()];
  const currentStates = states.filter(s => ids.includes(s.stream_id) && belongs(s));
  // A removal only matters to a viewer that may still show that draft. Old removals (a long recess of hidden filler
  // loops) would fill the viewer's 200-row window and push the earlier sentences out of it.
  const recent = item => item.display_state !== 'removed' || Date.now() - (item.audio_received_ms ?? 0) < 600_000;
  return { ...snapshot, publication_policy: 'ai-corrected-v1', schedule: context.schedule?.view() ?? null, engine: engineStatus(scheduler),
    live_policy: 'whisper-draft-v1', live_segments: textIds.flatMap(id => publicLiveSegments(store, id, broadcasts[id]).filter(belongs).map(viewerLiveSegment).filter(item => item && recent(item))),
    live_pending: textIds.map(id => pendingManifest(store, id, broadcasts[id])),
    ...deliveryHealth(context, ids, { states: currentStates }),
    streams: snapshot.streams.map(viewerStream), segments: pages.flatMap(page => page.items).map(viewerSegment).filter(Boolean),
    before: Object.fromEntries(pages.map(page => [page.stream, page.before])),
    gaps: snapshot.gaps.filter(belongs).map(viewerGap), states: currentStates.map(viewerState) };
}
export function createViewer(context) {
  const { store, scheduler, config } = context;
  const feed = new EventFeed(store, { ...config, project: event => viewerEvent(event, context),
    ...(config.pushDeliveryHealth ? { heartbeatMs: 5000,
      heartbeatPayload: () => {
        const broadcasts = new Map(store.streams().map(stream => [stream.stream_id, stream.broadcast_id]));
        const states = [...new Map([...store.states(), ...scheduler.states()].map(s => [s.stream_id, s])).values()]
          .filter(s => publicSession(store, s) && (!broadcasts.get(s.stream_id)
            || context.registry?.forSession(s.session_id) === broadcasts.get(s.stream_id)));
        return { health: deliveryHealth(context, CHANNEL_IDS, { states }).health, engine: engineStatus(scheduler) };
      } } : {}) });
  const publicRegistry = context.registry && viewerMinutesRegistry(context.registry);
  const snapshotCache = new Map();
  let snapshotBytes = 0;
  // The viewers of one meeting ask for the same page of its record; within historyCacheMs (desktop listener: 10 s) they share
  // one answer. Earlier sentences rarely change, and a later version reaches connected viewers through the event stream.
  const pages = new Map();
  const remember = (key, text, now) => {
    for (const [old, entry] of pages) if (now - entry.time >= config.historyCacheMs) pages.delete(old);
    if (text.length > 4_000_000) return null;
    let size = 0; for (const entry of pages.values()) size += entry.text.length;
    for (const [old, entry] of pages) { if (pages.size < 32 && size + text.length <= 16_000_000) break; pages.delete(old); size -= entry.text.length; }
    const entry = { text, time: now, encoded: new Map() };
    pages.set(key, entry); return entry;
  };
  const evict = key => { snapshotBytes -= snapshotCache.get(key)?.bytes ?? 0; snapshotCache.delete(key); };
  const routes = new Set(['/api/viewer/snapshot', '/api/viewer/segments', '/api/viewer/events', '/api/viewer/schedule', '/api/viewer/status']);
  return {
    feed,
    handle(req, res, url) {
      if (publicRegistry && minutesRequest(publicRegistry, req, res, url, '/api/viewer/minutes', minutesPage)) return;
      if (!routes.has(url.pathname)) throw new HttpError(404, 'Route not found');
      if (req.method !== 'GET') throw new HttpError(405, 'Read-only endpoint');
      if (url.pathname === '/api/viewer/schedule') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(context.schedule?.view() ?? null)); return;
      }
      if (url.pathname === '/api/viewer/status') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ engine: engineStatus(scheduler) })); return;
      }
      const ids = (url.searchParams.get('streams') ?? CHANNEL_IDS.join(','))
        .split(',').filter(Boolean).map(identifier);
      if (ids.length > CHANNEL_IDS.length || ids.some(id => !CHANNEL_IDS.includes(id))) throw new HttpError(400, 'Invalid channels');
      if (url.pathname === '/api/viewer/events') {
        feed.connect(req, res, ids, integer(url.searchParams.get('after') ?? 0, 0, Number.MAX_SAFE_INTEGER));
        return;
      }
      let result;
      const broadcasts = Object.fromEntries(store.streams().filter(stream => stream.broadcast_id).map(stream => [stream.stream_id, stream.broadcast_id]));
      if (url.pathname === '/api/viewer/segments') {
        if (!CHANNEL_IDS.includes(url.searchParams.get('stream'))) throw new HttpError(400, 'Invalid channel');
        const broadcast = url.searchParams.get('broadcast');
        if (broadcast && broadcast !== broadcasts[url.searchParams.get('stream')]) throw new HttpError(409, '방송이 변경되었습니다. 다시 선택해 주세요.');
        const q = url.searchParams.get('q') ?? '';
        if (q.length > 200) throw new HttpError(400, '검색어는 200자 이내입니다.');
        // Viewers load the whole record of a meeting at once (2026-11-21), up to 2,000 sentences per page.
        const query = { stream: identifier(url.searchParams.get('stream')), broadcast: broadcasts[url.searchParams.get('stream')],
          q, published: true,
          before: integer(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER),
          limit: integer(url.searchParams.get('limit') ?? 100, 1, 2000) };
        const key = JSON.stringify(query); const now = Date.now(); const hit = pages.get(key);
        let entry = hit && now - hit.time < (config.historyCacheMs ?? 0) ? hit : null;
        if (!entry) {
          const page = publicSegments(store, query);
          const items = page.items.map(viewerSegment).filter(Boolean);
          // A screen loaded before 2026-11-25 asks for the newest page of a record without sentences again as soon as the
          // empty answer arrives, once or twice a second for each open channel (docs/CLOUDFLARE.md). It stops when its
          // record holds any row, so the empty newest page carries one row that no screen draws. Sequence 1 is below
          // every sentence, so a screen that was away still loads the sentences before the ones it receives next.
          if (!items.length && !q && query.before === Number.MAX_SAFE_INTEGER) items.push({ stream_id: query.stream,
            segment_id: 'record-start', sequence: 1, version: 0, timeline_epoch: 0, start_ms: 0, end_ms: 0, text: '',
            ai_corrected: false, display_state: 'removed', speaker_id: null });
          const text = JSON.stringify({ ...page, before: page.items.length < query.limit ? 0 : page.before,
            broadcast_id: query.broadcast ?? null, items });
          entry = (config.historyCacheMs && remember(key, text, now)) || { text, encoded: new Map() };
        }
        sendJson(req, res, {}, entry.text, entry.encoded); return;
      } else {
        const texts = (url.searchParams.get('text_streams') ?? ids.join(',')).split(',').filter(Boolean).map(identifier);
        if (texts.length > CHANNEL_IDS.length || texts.some(id => !CHANNEL_IDS.includes(id))) throw new HttpError(400, 'Invalid channels');
        const key = JSON.stringify([[...new Set(ids)].sort(), [...new Set(texts)].sort()]); const now = Date.now();
        const cached = snapshotCache.get(key);
        let text; let etag; let encoded = new Map();
        if (cached && now - cached.time < (config.snapshotCacheMs ?? 0)) ({ text, etag, encoded } = cached);
        else {
          result = selectSnapshotText(viewerSnapshot(context, ids, texts), texts.filter(id => ids.includes(id)));
          text = JSON.stringify(result); etag = snapshotEtag(text);
          if (config.snapshotCacheMs) {
            for (const [oldKey, value] of snapshotCache) if (now - value.time >= config.snapshotCacheMs) evict(oldKey);
            evict(key);
            const bytes = Buffer.byteLength(text);
            if (bytes <= 1_048_576) {
              while (snapshotCache.size >= 128 || snapshotBytes + bytes > 8_388_608) evict(snapshotCache.keys().next().value);
              snapshotCache.set(key, { text, etag, time: now, bytes, encoded }); snapshotBytes += bytes;
            }
          }
        }
        if (matchesEtag(req.headers['if-none-match'], etag)) { res.writeHead(304, { ETag: etag }); res.end(); return; }
        sendJson(req, res, { ETag: etag }, text, encoded); return;
      }
    }
  };
}
