import { createHash } from 'node:crypto';

export function selectSnapshotText(snapshot, ids) {
  const selected = new Set(ids);
  const matches = item => selected.has(item.stream_id);
  return { ...snapshot, segments: snapshot.segments.filter(matches), live_segments: (snapshot.live_segments ?? []).filter(matches),
    live_pending: (snapshot.live_pending ?? []).filter(matches),
    before: Object.fromEntries(Object.entries(snapshot.before ?? {}).filter(([id]) => selected.has(id))) };
}

export function snapshotEtag(text) {
  return 'W/"' + createHash('sha256').update(text).digest('hex') + '"';
}

export function matchesEtag(header, etag) {
  return typeof header === 'string' && header.split(',').some(value => value.trim() === etag);
}
