import { EventFeed } from './events.mjs';
import { HttpError, identifier, integer } from './validate.mjs';
import { minutesRequest } from './minutes-http.mjs';
import { CHANNEL_IDS } from '../public/committees.mjs';
import { viewerMinutesRegistry } from './viewer-minutes.mjs';

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
export function viewerSegment(segment) {
  if (segment.ai_corrected !== true || typeof segment.corrected_text !== 'string' || !segment.corrected_text.trim()) return null;
  const { stream_id, session_id, timeline_epoch, segment_id, start_ms, end_ms,
    corrected_text, version, speaker_id } = segment;
  return { stream_id, session_id, timeline_epoch, segment_id, start_ms, end_ms, text: corrected_text,
    ai_corrected: true, version, speaker_id: speaker_id ?? null,
    ...(segment.speaker_state ? { speaker_scope: segment.speaker_scope ?? null, speaker_state: segment.speaker_state,
      speaker_ids: [...new Set((segment.speaker_turns ?? []).filter(turn => turn.end_ms - turn.start_ms >= 200).map(turn => turn.speaker_id))] } : {}) };
}
function viewerEvent(event) {
  let payload = {};
  switch (event.kind) {
    case 'stream': payload = viewerStream(event.payload); break;
    case 'session': case 'status': payload = viewerState(event.payload); break;
    case 'gap': payload = viewerGap(event.payload); break;
    case 'segment': payload = viewerSegment(event.payload); if (!payload) return null; break;
    case 'partial': return null;
  }
  return { event_id: event.event_id, kind: event.kind, payload };
}
export function viewerSnapshot(context, ids) {
  const { store, scheduler, registry } = context;
  const broadcasts = Object.fromEntries(store.streams().filter(stream => stream.broadcast_id).map(stream => [stream.stream_id, stream.broadcast_id]));
  const belongs = value => !broadcasts[value.stream_id] || registry?.forSession(value.session_id) === broadcasts[value.stream_id];
  const snapshot = store.snapshot(ids, broadcasts, true);
  const states = [...new Map([...store.states(), ...scheduler.states()].map(s => [s.stream_id, s])).values()];
  return { ...snapshot, publication_policy: 'ai-corrected-v1', schedule: context.schedule?.view() ?? null,
    streams: snapshot.streams.map(viewerStream), segments: snapshot.segments.map(viewerSegment).filter(Boolean),
    gaps: snapshot.gaps.filter(belongs).map(viewerGap), states: states.filter(s => ids.includes(s.stream_id) && belongs(s)).map(viewerState) };
}
export function createViewer(context) {
  const { store, scheduler, config } = context;
  const feed = new EventFeed(store, { ...config, project: viewerEvent });
  const publicRegistry = context.registry && viewerMinutesRegistry(context.registry);
  const routes = new Set(['/api/viewer/snapshot', '/api/viewer/segments', '/api/viewer/events', '/api/viewer/schedule']);
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
        const q = url.searchParams.get('q') ?? '';
        if (q.length > 200) throw new HttpError(400, '검색어는 200자 이내입니다.');
        const page = store.segments({ stream: identifier(url.searchParams.get('stream')),
          broadcast: broadcasts[url.searchParams.get('stream')],
          q, published: true,
          before: integer(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER),
          limit: integer(url.searchParams.get('limit') ?? 100, 1, 200) });
        result = { ...page, items: page.items.map(viewerSegment).filter(Boolean) };
      } else {
        result = viewerSnapshot(context, ids);
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    }
  };
}
