import { buildMinutes } from './minutes.mjs';

const cache = new WeakMap();
export function viewerMinutesRegistry(registry) {
  return { minuteList: () => viewerMinuteList(registry), minutes: id => viewerMinutes(registry, id) };
}
export function viewerMinuteList(registry) {
  // Published (AI-corrected) sentences per recording session and timeline epoch. A meeting's length is the broadcast time
  // from the first to the last published sentence of each of them, added up. Positions are broadcast time: a recording that
  // caught up from the start of a live stream covers more broadcast than the clock time it took (2026-11-04 forum: 2 h 25 min
  // of broadcast in 26 minutes).
  const meetings = new Map(); const owners = new Map();
  for (const row of registry.db.prepare('SELECT session_id,broadcast_id FROM broadcast_sessions').all())
    owners.set(row.session_id, [...owners.get(row.session_id) ?? [], row.broadcast_id]);
  for (const row of registry.db.prepare("SELECT session_id,count(*) AS total,min(start_ms) AS first,"
    + "max(json_extract(document,'$.end_ms')) AS last FROM segments WHERE json_extract(document,'$.ai_corrected')=1 "
    + "AND trim(coalesce(json_extract(document,'$.corrected_text'),''))<>'' GROUP BY session_id,json_extract(document,'$.timeline_epoch')").all()) {
    for (const id of owners.get(row.session_id) ?? []) {
      const meeting = meetings.get(id) ?? { count: 0, duration: 0 }; meetings.set(id, meeting);
      meeting.count += row.total; if (row.last > row.first) meeting.duration += row.last - row.first;
    }
  }
  return registry.minuteList().filter(summary => registry.get(summary.id)?.test_run !== true).map(summary => {
    const meeting = meetings.get(summary.id);
    return { ...summary, segment_count: meeting?.count ?? 0, ...(meeting ? { duration_ms: Math.round(meeting.duration) } : {}),
      publication_policy: 'ai-corrected-v1' };
  });
}
export function viewerMinutes(registry, id) {
  const stored = registry.minutes(id); if (!stored || registry.get(id)?.test_run === true) return null;
  const revision = registry.revision(id); const key = JSON.stringify([revision, stored.updated_ms]);
  let entries = cache.get(registry); if (!entries) { entries = new Map(); cache.set(registry, entries); }
  if (entries.get(id)?.key === key) return entries.get(id).value;
  const rows = registry.segments(id);
  const published = registry.publishedSegments(id);
  const value = buildMinutes(registry.get(id), registry.sessions(id), published, registry.gaps(id),
    { participants: registry.participants(id), summary: registry.summary(id), finalSpeakers: registry.finalSpeakers(id),
      videoAlignment: registry.reviewState('video-alignment:' + id) });
  value.publication_policy = 'ai-corrected-v1'; value.pending_segment_count = rows.length - published.length;
  value.updated_ms = stored.updated_ms;
  value.warnings.unshift('AI 후보정이 완료된 문장만 표시합니다. 후보정 전 문장은 공개하지 않습니다.');
  if (published.length && stored.structured?.scope === 'published' && !stored.structured.stale) {
    value.structured = stored.structured; value.method = 'grounded_ai';
  }
  if (!entries.has(id) && entries.size >= 8) entries.delete(entries.keys().next().value);
  entries.set(id, { key, value }); return value;
}
