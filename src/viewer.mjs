import { EventFeed } from './events.mjs';
import { HttpError, identifier, integer } from './validate.mjs';

export function viewerStream(stream) {
  const { stream_id, name, page_url, video_id } = stream;
  return { stream_id, name, page_url, video_id };
}
function viewerState(state) {
  const { stream_id, session_id, timeline_epoch, state: status, started_ms, last_receive_ms } = state;
  return { stream_id, session_id, timeline_epoch, state: status, started_ms, last_receive_ms };
}
function viewerGap(gap) {
  const { stream_id, session_id, timeline_epoch, start_ms, end_ms } = gap;
  return { stream_id, session_id, timeline_epoch, start_ms, end_ms };
}
function viewerSegment(segment) {
  const { stream_id, session_id, timeline_epoch, segment_id, start_ms, end_ms,
    raw_text, corrected_text, version } = segment;
  return { stream_id, session_id, timeline_epoch, segment_id, start_ms, end_ms, raw_text, corrected_text, version };
}
function viewerEvent(event) {
  let payload = {};
  switch (event.kind) {
    case 'stream': payload = viewerStream(event.payload); break;
    case 'session': case 'status': payload = viewerState(event.payload); break;
    case 'gap': payload = viewerGap(event.payload); break;
    case 'segment': payload = viewerSegment(event.payload); break;
  }
  return { event_id: event.event_id, kind: event.kind, payload };
}
export function createViewer(context) {
  const { store, scheduler, config } = context;
  const feed = new EventFeed(store, { ...config, project: viewerEvent });
  const routes = new Set(['/api/viewer/snapshot', '/api/viewer/segments', '/api/viewer/events']);
  return {
    feed,
    handle(req, res, url) {
      if (!routes.has(url.pathname)) throw new HttpError(404, 'Route not found');
      if (req.method !== 'GET') throw new HttpError(405, 'Read-only endpoint');
      const ids = (url.searchParams.get('streams') ?? 'ch1,ch2,ch3,ch4,ch5,ch6,ch7,ch8')
        .split(',').filter(Boolean).map(identifier);
      if (ids.length > 8 || ids.some(id => !/^ch[1-8]$/.test(id))) throw new HttpError(400, 'Invalid channels');
      if (url.pathname === '/api/viewer/events') {
        feed.connect(req, res, ids, integer(url.searchParams.get('after') ?? 0, 0, Number.MAX_SAFE_INTEGER));
        return;
      }
      let result;
      if (url.pathname === '/api/viewer/segments') {
        const page = store.segments({ stream: identifier(url.searchParams.get('stream')),
          before: integer(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER),
          limit: integer(url.searchParams.get('limit') ?? 100, 1, 200) });
        result = { ...page, items: page.items.map(viewerSegment) };
      } else {
        const snapshot = store.snapshot(ids);
        const states = [...new Map([...store.states(), ...scheduler.states()].map(s => [s.stream_id, s])).values()];
        result = { ...snapshot, streams: snapshot.streams.map(viewerStream),
          segments: snapshot.segments.map(viewerSegment), gaps: snapshot.gaps.map(viewerGap),
          states: states.filter(s => ids.includes(s.stream_id)).map(viewerState) };
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    }
  };
}
