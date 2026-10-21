import { buildMinutes } from './minutes.mjs';

const cache = new WeakMap();
export function viewerMinutesRegistry(registry) {
  return { minuteList: () => viewerMinuteList(registry), minutes: id => viewerMinutes(registry, id) };
}
export function viewerMinuteList(registry) {
  const counts = new Map(registry.db.prepare("SELECT b.broadcast_id,count(*) AS total FROM segments s JOIN broadcast_sessions b ON b.session_id=s.session_id "
    + "WHERE json_extract(s.document,'$.ai_corrected')=1 AND trim(coalesce(json_extract(s.document,'$.corrected_text'),''))<>'' GROUP BY b.broadcast_id")
    .all().map(row => [row.broadcast_id, row.total]));
  return registry.minuteList().filter(summary => registry.get(summary.id)?.test_run !== true)
    .map(summary => ({ ...summary, segment_count: counts.get(summary.id) ?? 0, publication_policy: 'ai-corrected-v1' }));
}
export function viewerMinutes(registry, id) {
  const stored = registry.minutes(id); if (!stored || registry.get(id)?.test_run === true) return null;
  const revision = registry.revision(id); const key = JSON.stringify([revision, stored.updated_ms]);
  let entries = cache.get(registry); if (!entries) { entries = new Map(); cache.set(registry, entries); }
  if (entries.get(id)?.key === key) return entries.get(id).value;
  const rows = registry.segments(id);
  const published = registry.publishedSegments(id);
  const value = buildMinutes(registry.get(id), registry.sessions(id), published, registry.gaps(id),
    { participants: registry.participants(id), summary: registry.summary(id) });
  value.publication_policy = 'ai-corrected-v1'; value.pending_segment_count = rows.length - published.length;
  value.updated_ms = stored.updated_ms;
  value.warnings.unshift('AI 후보정이 완료된 문장만 표시합니다. 후보정 전 문장은 공개하지 않습니다.');
  if (published.length && stored.structured?.scope === 'published' && !stored.structured.stale) {
    value.structured = stored.structured; value.method = 'grounded_ai';
  }
  if (!entries.has(id) && entries.size >= 8) entries.delete(entries.keys().next().value);
  entries.set(id, { key, value }); return value;
}
