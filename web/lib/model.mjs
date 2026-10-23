export class CloudError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = () => { throw new CloudError(400, 'Invalid public data'); };
const obj = value => value && typeof value === 'object' && !Array.isArray(value) ? value : fail();
const str = (value, max = 5000) => typeof value === 'string' && value.length <= max ? value : fail();
const num = (value, max = Number.MAX_SAFE_INTEGER) => Number.isFinite(value) && value >= 0 && value <= max ? value : fail();
const int = value => Number.isSafeInteger(value) ? num(value) : fail();
const list = (value, max, project) => Array.isArray(value) && value.length <= max ? value.map(project) : fail();
const optional = (value, project) => value === null || value === undefined ? null : project(value);
const publishedSegments = (value, max) => list(value, max, obj).filter(s => s.ai_corrected === true && typeof s.text === 'string' && s.text.trim()).map(publicSegment);
export const channelId = value => /^ch(?:[0-9]|1[0-2])$/.test(value) ? value : fail();
export const broadcastId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : fail();
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : fail();
const source = value => {
  let url;
  try { url = new URL(str(value, 1000)); } catch { fail(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !['www.youtube.com', 'youtube.com', 'youtu.be', 'www.council.jeju.kr'].includes(url.hostname)) fail();
  return url.href;
};
const video = value => typeof value === 'string' && /^[A-Za-z0-9_-]{11}$/.test(value) ? value : fail();
export function publicStream(value) {
  const s = obj(value);
  return { stream_id: channelId(s.stream_id), name: str(s.name, 300), page_url: s.page_url ? source(s.page_url) : '',
    video_id: optional(s.video_id, video), broadcast_id: optional(s.broadcast_id, broadcastId) };
}
export function publicSegment(value) {
  const s = obj(value); const start_ms = num(s.start_ms); const end_ms = num(s.end_ms);
  if (end_ms < start_ms || s.ai_corrected !== true || typeof s.text !== 'string' || !s.text.trim()) fail();
  return { stream_id: channelId(s.stream_id), session_id: identifier(s.session_id), segment_id: identifier(s.segment_id),
    timeline_epoch: int(s.timeline_epoch ?? 0), start_ms, end_ms, text: str(s.text), ai_corrected: true,
    audio_received_ms: optional(s.audio_received_ms, int),
    sequence: optional(s.sequence, int),
    version: int(s.version), speaker_id: optional(s.speaker_id, value => { if (value < 1 || value > 8) fail(); return int(value); }),
    ...speakerFields(s) };
}
function speakerFields(s) {
  if (!s.speaker_state) return {};
  if (!['pending', 'assigned', 'multiple', 'unknown', 'unavailable'].includes(s.speaker_state)) fail();
  return { speaker_scope: optional(s.speaker_scope, identifier), speaker_state: s.speaker_state,
    speaker_ids: list(s.speaker_ids ?? [], 8, value => { if (value < 1 || value > 8) fail(); return int(value); }) };
}
export function publicState(value) {
  const s = obj(value);
  if (!['running', 'draining', 'stopped', 'degraded', 'interrupted', 'reconnecting'].includes(s.state)) fail();
  return { stream_id: channelId(s.stream_id), session_id: identifier(s.session_id), state: s.state,
    timeline_epoch: int(s.timeline_epoch ?? 0), started_ms: num(s.started_ms ?? 0),
    last_receive_ms: optional(s.last_receive_ms, num), partial: null };
}
export function publicLiveSegment(value) {
  const s = obj(value);
  if (s.display_state === 'corrected') return { ...publicSegment(s), display_state: 'corrected' };
  if (!['draft', 'removed'].includes(s.display_state) || s.ai_corrected !== false
    || (s.display_state === 'removed' && s.text !== '') || (s.display_state === 'draft' && !str(s.text).trim())) fail();
  const projected = publicSegment({ ...s, text: s.text || 'removed', ai_corrected: true });
  return { ...projected, text: s.text, ai_corrected: false, display_state: s.display_state };
}
export function publicGap(value) {
  const s = obj(value);
  return { stream_id: channelId(s.stream_id), session_id: identifier(s.session_id), timeline_epoch: int(s.timeline_epoch ?? 0),
    start_ms: optional(s.start_ms, num), end_ms: optional(s.end_ms, num) };
}
const scheduleItem = value => {
  const s = obj(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str(s.date, 10)) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(str(s.time, 5))
    || !['scheduled', 'live'].includes(s.status)) fail();
  return { date: s.date, time: s.time, starts_at: s.date + 'T' + s.time + ':00+09:00', title: str(s.title, 300),
    status: s.status, stream_id: optional(s.stream_id, channelId) };
};
export function publicSchedule(value) {
  const s = obj(value);
  if (s.source_url !== 'https://www.council.jeju.kr/broadcast/schedule.do') fail();
  return { source_url: s.source_url, updated_ms: optional(s.updated_ms, int), items: list(s.items, 60, scheduleItem) };
}
export function publicSnapshot(value) {
  const s = obj(value); const streams = list(s.streams, 13, publicStream);
  if (new Set(streams.map(item => item.stream_id)).size !== streams.length) fail();
  return { publication_policy: 'ai-corrected-v1', event_id: int(s.event_id), streams, schedule: optional(s.schedule, publicSchedule),
    live_policy: 'whisper-draft-v1', live_segments: s.live_policy === 'whisper-draft-v1' ? list(s.live_segments ?? [], 2600, publicLiveSegment) : [],
    live_pending: s.live_policy === 'whisper-draft-v1' ? list(s.live_pending ?? [], 13, value => {
      const entry = obj(value); if (typeof entry.complete !== 'boolean') fail();
      return { stream_id: channelId(entry.stream_id), broadcast_id: optional(entry.broadcast_id, broadcastId),
        complete: entry.complete, segment_ids: list(entry.segment_ids, 10000, identifier) };
    }) : [],
    segments: publishedSegments(s.segments, 1300),
    states: list(s.states, 13, publicState), gaps: list(s.gaps, 13, publicGap),
    health: list(s.health ?? [], 13, publicHealth), publication: optional(s.publication, publicPublication),
    before: Object.fromEntries(streams.map(stream => [stream.stream_id, int(s.before?.[stream.stream_id] ?? 0)])) };
}
const choice = (value, values) => values.includes(value) ? value : fail();
function publicPublication(value) {
  const s = obj(value);
  return { status: choice(s.status, ['disabled', 'waiting', 'publishing', 'published', 'delayed']),
    last_published_ms: optional(s.last_published_ms, num), stale_after_ms: num(s.stale_after_ms, 10800000) };
}
function publicHealth(value) {
  const s = obj(value); const stages = obj(s.stages);
  return { stream_id: channelId(s.stream_id),
    status: choice(s.status, ['waiting', 'silent', 'processing', 'correction_delayed', 'delayed', 'ready', 'stopped']),
    stage: optional(s.stage, value => choice(value, ['ingestion', 'transcription', 'correction', 'publication'])),
    last_received_ms: optional(s.last_received_ms, num), last_processed_ms: optional(s.last_processed_ms, num),
    last_corrected_ms: optional(s.last_corrected_ms, num),
    stages: Object.fromEntries(['ingestion', 'transcription', 'correction', 'publication'].map(key =>
      [key, choice(stages[key], ['disabled', 'waiting', 'publishing', 'published', 'delayed', 'ready', 'stopped', 'silent', 'processing'])])) };
}
const excerpt = value => {
  const s = obj(value);
  return { session_number: int(s.session_number), epoch: int(s.epoch), start_ms: num(s.start_ms),
    end_ms: num(s.end_ms), text: str(s.text), ai_corrected: s.ai_corrected === true,
    ...(s.segment_id ? { segment_id: identifier(s.segment_id), corrected: s.corrected === true } : {}),
    ...(Array.isArray(s.segment_ids) ? { segment_ids: list(s.segment_ids, 400, identifier) } : {}),
    speaker_key: optional(s.speaker_key, speakerKey), ...finalSpeakerFields(s),
    speaker_id: optional(s.speaker_id, value => { if (value < 1 || value > 8) fail(); return int(value); }), ...speakerFields(s) };
};
const speakerKey = value => typeof value === 'string' && /^[A-Za-z0-9-]{0,40}:[1-8]$/.test(value) ? value : fail();
function finalSpeakerFields(s) {
  return { speaker_final: s.speaker_final === true, speaker_name: optional(s.speaker_name, value => str(value, 60)),
    speaker_role: optional(s.speaker_role, value => ['member', 'official', 'unknown'].includes(value) ? value : fail()) };
}
const participant = value => {
  const s = obj(value);
  return { key: speakerKey(s.key), speaker_id: int(s.speaker_id), label: str(s.label, 80), named: s.named === true, ...finalSpeakerFields(s),
    paragraph_count: int(s.paragraph_count), first_ms: num(s.first_ms), seconds: int(s.seconds) };
};
const publicSummary = value => {
  const s = obj(value);
  return { method: 'grounded_ai', model: str(s.model ?? '', 200), updated_ms: int(s.updated_ms),
    items: list(s.items, 1000, value => { const item = obj(value); return { text: str(item.text, 2000), quote: str(item.quote ?? '', 2000), source_id: str(item.source_id ?? '', 120) }; }) };
};
const evidence = value => { const e = obj(value); return { segment_id: optional(e.segment_id, identifier), quote: str(e.quote, 2000) }; };
const digestItem = (value, max) => { const item = obj(value); return { text: str(item.text, max), evidence: list(item.evidence, 30, evidence) }; };
const publicDigest = value => {
  const d = obj(value);
  return { overview: digestItem(d.overview, 260), topics: list(d.topics, 6, value => {
    const topic = obj(value); return { title: str(topic.title, 80), items: list(topic.items, 3, item => digestItem(item, 180)) };
  }) };
};
const timelineGroup = value => {
  const g = obj(value);
  return { group: int(g.group), title: str(g.title ?? '', 100), session_number: int(g.session_number), start_ms: num(g.start_ms),
    items: list(g.items, 100, value => { const item = obj(value); return { text: str(item.text, 2000), quote: str(item.quote, 2000), segment_id: optional(item.segment_id, identifier) }; }) };
};
export function minutesSummary(value) {
  const s = obj(value);
  if (!['in_progress', 'draft'].includes(s.status)) fail();
  return { id: broadcastId(s.id), title: str(s.title, 300), scheduled_at: str(s.scheduled_at ?? '', 300),
    status: s.status, updated_ms: int(s.updated_ms), segment_count: s.publication_policy === 'ai-corrected-v1' ? int(s.segment_count) : 0,
    session_count: int(s.session_count), publication_policy: 'ai-corrected-v1' };
}
export function publicMinutes(value) {
  const s = obj(value); const summary = minutesSummary(s);
  const safe = s.publication_policy === 'ai-corrected-v1' && ['transcript', 'discussion', 'paragraphs']
    .every(key => list(s[key] ?? [], 60000, obj).every(item => item.ai_corrected === true));
  const reasons = new Set(['process_restart', 'queue_overflow', 'inference_failed', 'input_discontinuity',
    'collector_failed', 'source_resolution_failed', 'capture_transport_loss', 'beginning_collection_failed']);
  return { ...summary, segment_count: safe ? summary.segment_count : 0,
    pending_segment_count: int(s.pending_segment_count ?? 0), sources: list(s.sources, 16, source), meeting_round: str(s.meeting_round ?? '', 300),
    meeting_type: str(s.meeting_type ?? '', 300), committee: str(s.committee ?? '', 300), agenda: str(s.agenda ?? '', 30000),
    method: safe && s.method === 'grounded_ai' ? 'grounded_ai' : 'extractive_transcript',
    warnings: safe ? list(s.warnings, 20, v => str(v, 2000)) : ['AI 후보정이 완료된 공개 자료를 기다립니다.'],
    structured: optional(safe ? s.structured : null, value => {
      const note = obj(value);
      return { stale: note.stale === true, sources: list(note.sources, 60000, value => {
        const source = obj(value); return { id: identifier(source.id), segment_id: identifier(source.segment_id), start_ms: num(source.start_ms) };
      }), notes: list(note.notes, 10000, value => {
        const batch = obj(value); return Object.fromEntries(['summary','decisions','proposals','actions','numbers','open_questions'].map(key => [key,
          list(batch[key], 100, value => { const fact = obj(value); return { text: str(fact.text, 2000), source_id: identifier(fact.source_id), quote: str(fact.quote, 2000), owner: optional(fact.owner, str), due: optional(fact.due, str) }; })]));
      }) };
    }),
    discussion: list(safe ? s.discussion : [], 20, excerpt), paragraphs: list(safe ? s.paragraphs ?? [] : [], 60000, excerpt),
    participants: list(safe ? s.participants ?? [] : [], 160, participant), summary: optional(safe ? s.summary : null, publicSummary),
    digest: optional(safe ? s.digest : null, publicDigest), timeline: list(safe ? s.timeline ?? [] : [], 500, timelineGroup),
    final_speakers: optional(safe ? s.final_speakers : null, value => {
      const review = obj(value); if (!['live', 'pending', 'partial', 'complete'].includes(review.phase)) fail();
      return { phase: review.phase, assigned: int(review.assigned), unresolved: int(review.unresolved), updated_ms: int(review.updated_ms) };
    }),
    transcript: list(safe ? s.transcript : [], 60000, excerpt),
    gaps: list(s.gaps, 20000, value => {
      const g = obj(value); return { session_number: int(g.session_number), epoch: int(g.epoch),
        start_ms: optional(g.start_ms, num), end_ms: optional(g.end_ms, num),
        reason: reasons.has(g.reason) ? g.reason : 'input_discontinuity' };
    }), markdown: safe ? str(s.markdown, 16000000) : 'AI 후보정이 완료된 공개 자료를 기다립니다.\n' };
}
export function publicUpdate(value) {
  const s = obj(value); const published_ms = int(s.published_ms);
  if (s.kind === 'snapshot') return { kind: s.kind, published_ms, publication_policy: 'ai-corrected-v1', snapshot: publicSnapshot(s.snapshot),
    minutes_index: list(s.minutes_index, 20000, minutesSummary) };
  if (s.kind === 'minutes') return { kind: s.kind, published_ms, publication_policy: 'ai-corrected-v1', document: publicMinutes(s.document),
    segments: publishedSegments(s.segments, 60000) };
  fail();
}
