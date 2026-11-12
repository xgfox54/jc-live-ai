import { EventFeed } from './events.mjs';
import { HttpError, identifier, integer } from './validate.mjs';
import { minutesRequest } from './minutes-http.mjs';
import { CHANNEL_IDS } from '../public/committees.mjs';
import { viewerMinutesRegistry } from './viewer-minutes.mjs';
import { publicSpeech, suspectText, publicText } from './silence-filter.mjs';
import { deliveryHealth } from './delivery-health.mjs';
import { selectSnapshotText, snapshotEtag, matchesEtag } from '../web/lib/snapshot-selection.mjs';

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
  while (items.length < limit) {
    const remaining = limit - items.length;
    const page = store.segments({ ...query, before, limit: remaining });
    // Rows hidden as silence artifacts do not fill the page, so a long recess cannot push earlier sentences out of it.
    items = [...page.items.filter(row => publicSession(store, row) && publicSpeech(row)), ...items];
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
export function viewerSnapshot(context, ids) {
  const { store, scheduler, registry } = context;
  const broadcasts = Object.fromEntries(store.streams().filter(stream => stream.broadcast_id).map(stream => [stream.stream_id, stream.broadcast_id]));
  const belongs = value => publicSession(store, value)
    && (!broadcasts[value.stream_id] || registry?.forSession(value.session_id) === broadcasts[value.stream_id]);
  const snapshot = store.snapshot(ids, broadcasts, true);
  const pages = ids.map(stream => ({ stream, ...publicSegments(store, { stream, broadcast: broadcasts[stream], published: true }) }));
  const states = [...new Map([...store.states(), ...scheduler.states()].map(s => [s.stream_id, s])).values()];
  const currentStates = states.filter(s => ids.includes(s.stream_id) && belongs(s));
  // A removal only matters to a viewer that may still show that draft. Old removals (a long recess of hidden filler
  // loops) would fill the viewer's 200-row window and push the earlier sentences out of it.
  const recent = item => item.display_state !== 'removed' || Date.now() - (item.audio_received_ms ?? 0) < 600_000;
  return { ...snapshot, publication_policy: 'ai-corrected-v1', schedule: context.schedule?.view() ?? null, engine: engineStatus(scheduler),
    live_policy: 'whisper-draft-v1', live_segments: ids.flatMap(id => publicLiveSegments(store, id, broadcasts[id]).filter(belongs).map(viewerLiveSegment).filter(item => item && recent(item))),
    live_pending: ids.map(id => pendingManifest(store, id, broadcasts[id])),
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
  const evict = key => { snapshotBytes -= snapshotCache.get(key)?.bytes ?? 0; snapshotCache.delete(key); };
  const routes = new Set(['/api/viewer/snapshot', '/api/viewer/segments', '/api/viewer/events', '/api/viewer/schedule', '/api/viewer/status']);
  return {
    feed,
    handle(req, res, url) {
      if (publicRegistry && minutesRequest(publicRegistry, req, res, url, '/api/viewer/minutes')) return;
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
        const page = publicSegments(store, { stream: identifier(url.searchParams.get('stream')),
          broadcast: broadcasts[url.searchParams.get('stream')],
          q, published: true,
          before: integer(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER),
          limit: integer(url.searchParams.get('limit') ?? 100, 1, 200) });
        result = { ...page, before: page.items.length < Number(url.searchParams.get('limit') ?? 100) ? 0 : page.before,
          broadcast_id: broadcasts[url.searchParams.get('stream')] ?? null, items: page.items.map(viewerSegment).filter(Boolean) };
      } else {
        const texts = (url.searchParams.get('text_streams') ?? ids.join(',')).split(',').filter(Boolean).map(identifier);
        if (texts.length > CHANNEL_IDS.length || texts.some(id => !CHANNEL_IDS.includes(id))) throw new HttpError(400, 'Invalid channels');
        const key = JSON.stringify([[...new Set(ids)].sort(), [...new Set(texts)].sort()]); const now = Date.now();
        const cached = snapshotCache.get(key);
        let text; let etag;
        if (cached && now - cached.time < (config.snapshotCacheMs ?? 0)) ({ text, etag } = cached);
        else {
          result = selectSnapshotText(viewerSnapshot(context, ids), texts.filter(id => ids.includes(id)));
          text = JSON.stringify(result); etag = snapshotEtag(text);
          if (config.snapshotCacheMs) {
            for (const [oldKey, value] of snapshotCache) if (now - value.time >= config.snapshotCacheMs) evict(oldKey);
            evict(key);
            const bytes = Buffer.byteLength(text);
            if (bytes <= 1_048_576) {
              while (snapshotCache.size >= 128 || snapshotBytes + bytes > 8_388_608) evict(snapshotCache.keys().next().value);
              snapshotCache.set(key, { text, etag, time: now, bytes }); snapshotBytes += bytes;
            }
          }
        }
        if (matchesEtag(req.headers['if-none-match'], etag)) { res.writeHead(304, { ETag: etag }); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ETag: etag }); res.end(text); return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    }
  };
}
