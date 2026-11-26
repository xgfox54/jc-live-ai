import { finalSourceGuard, REVIEW_METHOD, PREVIOUS_METHODS } from './final-speakers.mjs';
import { decisionOverlay } from './speaker-decisions.mjs';
import { publicSpeech, publicText } from './silence-filter.mjs';
import { budgetYears } from './budget-year.mjs';
import { createHash } from 'node:crypto';

// When the official list showed a meeting on air, in recess and off air (read every 30 seconds). The council replay leaves
// recesses out, so a replay recovered later takes its wall time from these marks (replay-recovery.mjs). On 2026-11-26 none
// were kept, and the evening resumption of a recovered meeting was shown at 14:02.
export function airTimes(existing, candidate, now) {
  const times = {};
  if (candidate.phase === 'live' && !existing?.aired_from_ms) times.aired_from_ms = now;
  if (['offline', 'ended'].includes(candidate.phase) && existing && !['offline', 'ended'].includes(existing.phase)
    && (existing.aired_from_ms || existing.recess_spans?.length)) times.aired_until_ms = now;
  if (typeof candidate.recess === 'boolean' && candidate.recess !== (existing?.recess === true)) {
    const spans = [...(existing?.recess_spans ?? [])];
    if (candidate.recess) spans.push({ from_ms: now, to_ms: null });
    else if (spans.at(-1)?.to_ms === null) spans[spans.length - 1] = { ...spans.at(-1), to_ms: now };
    times.recess_spans = spans.slice(-50);
  }
  return times;
}

export class BroadcastRegistry {
  constructor(store) {
    this.store = store; this.db = store.db;
    if (store.readOnly) return;
    this.db.exec('CREATE TABLE IF NOT EXISTS broadcasts(id TEXT PRIMARY KEY, document TEXT NOT NULL);'
      + 'CREATE TABLE IF NOT EXISTS broadcast_sessions(session_id TEXT PRIMARY KEY, broadcast_id TEXT NOT NULL);'
      + 'CREATE TABLE IF NOT EXISTS automation_settings(id TEXT PRIMARY KEY, document TEXT NOT NULL);'
      + 'CREATE TABLE IF NOT EXISTS minutes(broadcast_id TEXT PRIMARY KEY, document TEXT NOT NULL);');
    this.db.exec("CREATE INDEX IF NOT EXISTS broadcast_session_group ON broadcast_sessions(broadcast_id);"
      + "CREATE INDEX IF NOT EXISTS broadcast_gap_session ON events(json_extract(payload,'$.session_id')) WHERE kind='gap';");
  }
  list() { return this.db.prepare('SELECT document FROM broadcasts ORDER BY rowid DESC').all().map(row => JSON.parse(row.document)); }
  get(id) { const row = this.db.prepare('SELECT document FROM broadcasts WHERE id=?').get(id); return row ? JSON.parse(row.document) : null; }
  save(value) {
    this.db.prepare('INSERT INTO broadcasts VALUES(?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document').run(value.id, JSON.stringify(value));
    this.store.emit('broadcast', value.id);
    return value;
  }
  // A part record (continuation) shares its meeting's video and sources but is never merged into it.
  upsert(candidate) {
    const matches = this.list().filter(item => !item.continuation_of && ((candidate.video_id && item.video_id === candidate.video_id)
      || item.sources.some(url => candidate.sources.includes(url)))).sort((a, b) => a.first_seen_ms - b.first_seen_ms);
    const existing = matches[0];
    const official = matches.find(item => item.kind === 'council');
    const id = existing?.id ?? createHash('sha256').update(candidate.video_id ? 'youtube:' + candidate.video_id : candidate.page_url).digest('hex');
    const metadata = Object.fromEntries(Object.entries(candidate).filter(([, value]) => value !== '' && value !== null && value !== undefined));
    return this.store.transaction(() => {
      for (const duplicate of matches.slice(1)) {
        this.db.prepare('UPDATE broadcast_sessions SET broadcast_id=? WHERE broadcast_id=?').run(id, duplicate.id);
        this.db.prepare('DELETE FROM broadcasts WHERE id=?').run(duplicate.id);
        this.db.prepare('DELETE FROM minutes WHERE broadcast_id=?').run(duplicate.id);
        for (const stream of this.store.streams().filter(stream => stream.broadcast_id === duplicate.id))
          this.store.saveStream({ ...stream, broadcast_id: id });
      }
      return this.save({ ...existing, ...metadata, ...airTimes(existing, candidate, Date.now()), id, first_seen_ms: existing?.first_seen_ms ?? Date.now(), updated_ms: Date.now(),
        sources: [...new Set([...matches.flatMap(item => item.sources), ...candidate.sources])],
        ...(official && candidate.kind === 'youtube' ? {
          kind: official.kind, page_url: official.page_url, title: official.title, agenda: official.agenda,
          committee: official.committee, meeting_round: official.meeting_round, meeting_type: official.meeting_type,
          resolved_kind: official.resolved_kind, media_url: official.media_url,
          scheduled_at: official.scheduled_at || candidate.scheduled_at } : {}),
        suspended: matches.some(item => item.suspended), completed: matches.some(item => item.completed) });
    });
  }
  settings() {
    const row = this.db.prepare("SELECT document FROM automation_settings WHERE id='discovery'").get();
    return row ? JSON.parse(row.document) : { enabled: true };
  }
  setEnabled(enabled) {
    this.db.prepare("INSERT INTO automation_settings VALUES('discovery',?) ON CONFLICT(id) DO UPDATE SET document=excluded.document")
      .run(JSON.stringify({ enabled })); return this.settings();
  }
  suspend(id, value) { const record = this.get(id); if (record) this.save({ ...record, suspended: value }); }
  // A meeting of one session number that resumes on a later day is kept as one record per day (2026-11-24 request): the first
  // day is "<title> (1/2)" and the next "<title> (2/2)". display_title is what the minutes show; discovery updates title only.
  continuation(record, date, now = Date.now()) {
    const origin = record.continuation_of ? this.get(record.continuation_of) ?? record : record;
    const parts = this.list().filter(item => item.continuation_of === origin.id).sort((a, b) => a.part_date.localeCompare(b.part_date));
    const found = parts.find(item => item.part_date === date);
    if (found) return this.save({ ...found, completed: false });
    const base = origin.part_title ?? origin.display_title ?? origin.title;
    const time = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
    const fields = ['committee', 'meeting_round', 'meeting_type', 'agenda', 'kind', 'page_url', 'video_id', 'stream_id', 'resolved_kind', 'media_url', 'test_run'];
    const part = { ...Object.fromEntries(fields.filter(key => origin[key] !== undefined).map(key => [key, origin[key]])), sources: origin.sources ?? [],
      id: createHash('sha256').update('continuation:' + origin.id + ':' + date).digest('hex'), title: origin.title, continuation_of: origin.id,
      part_date: date, scheduled_at: date + ' ' + time, first_seen_ms: now, updated_ms: now, phase: 'live', completed: false, suspended: false };
    const ordered = [origin, ...parts, part];
    this.store.transaction(() => ordered.forEach((item, index) => this.save({ ...item, part_title: base,
      display_title: base + ' (' + (index + 1) + '/' + ordered.length + ')' })));
    return this.get(part.id);
  }
  attach(stream, session) {
    let record = stream.broadcast_id && this.get(stream.broadcast_id);
    if (!record) record = this.upsert({ title: stream.name, page_url: stream.page_url || 'local:' + stream.stream_id,
      sources: stream.page_url ? [stream.page_url] : [], video_id: stream.video_id, kind: stream.kind, phase: 'live' });
    this.db.prepare('INSERT OR IGNORE INTO broadcast_sessions VALUES(?,?)').run(session.session_id, record.id);
    this.save({ ...record, stream_id: stream.stream_id, phase: 'live', capture_from_start: Boolean(stream.capture_from_start),
      beginning_fallback: Boolean(stream.beginning_fallback),
      capture_mode: stream.beginning_fallback ? 'live_edge_fallback' : stream.capture_from_start ? 'beginning_requested' : 'live_edge' });
    return record.id;
  }
  forSession(id) { return typeof id === 'string' ? this.db.prepare('SELECT broadcast_id FROM broadcast_sessions WHERE session_id=?').get(id)?.broadcast_id : undefined; }
  sessions(id) {
    return this.db.prepare('SELECT s.document FROM sessions s JOIN broadcast_sessions b ON b.session_id=s.id WHERE b.broadcast_id=? ORDER BY s.rowid')
      .all(id).map(row => JSON.parse(row.document));
  }
  segments(id) {
    return this.db.prepare('SELECT s.document,s.rowid AS sequence FROM segments s JOIN broadcast_sessions b ON b.session_id=s.session_id WHERE b.broadcast_id=? ORDER BY s.rowid')
      .all(id).map(row => ({ ...JSON.parse(row.document), sequence: row.sequence }));
  }
  // "+e.id" keeps SQLite on the partial index broadcast_gap_session. Ordering by the bare rowid made it scan every event
  // instead (about 130 ms per call with 97,000 events, 2026-11-14).
  // created_ms is when the gap was recorded; the minutes use it to tell a stop after adjournment from a gap in the meeting.
  gaps(id) {
    return this.db.prepare("SELECT e.created_ms,e.payload FROM events e JOIN broadcast_sessions b ON json_extract(e.payload,'$.session_id')=b.session_id WHERE b.broadcast_id=? AND e.kind='gap' ORDER BY +e.id")
      .all(id).map(row => ({ ...JSON.parse(row.payload), created_ms: row.created_ms }));
  }
  saveMinutes(value) {
    this.db.prepare('INSERT INTO minutes VALUES(?,?) ON CONFLICT(broadcast_id) DO UPDATE SET document=excluded.document').run(value.id, JSON.stringify(value));
  }
  revision(id) {
    return this.db.prepare('SELECT count(*) AS total,coalesce(sum(s.version),0) AS version_sum FROM segments s JOIN broadcast_sessions b ON b.session_id=s.session_id WHERE b.broadcast_id=?').get(id);
  }
  // Revision of the AI-corrected rows only: public summaries are built from these rows and go stale only when they change.
  publishedRevision(id) {
    return this.db.prepare("SELECT count(*) AS total,coalesce(sum(s.version),0) AS version_sum FROM segments s JOIN broadcast_sessions b ON b.session_id=s.session_id "
      + "WHERE b.broadcast_id=? AND json_extract(s.document,'$.ai_corrected')=1 AND trim(coalesce(json_extract(s.document,'$.corrected_text'),''))<>''").get(id);
  }
  // Public rows lose phrases Whisper invented after the speech ("…상정합니다. MBC 뉴스 김성현입니다.") and write 제주 4.3 as 4.3.
  // In a budget hearing, a budget year heard ten years early is written as the year under review (src/budget-year.mjs).
  publishedSegments(id) {
    return budgetYears(this.segments(id).filter(row => row.ai_corrected === true && typeof row.corrected_text === 'string' && row.corrected_text.trim() && publicSpeech(row))
      .map(row => ({ ...row, corrected_text: publicText(row.corrected_text) })), this.get(id)?.agenda);
  }
  reviewState(key) {
    if (!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='review_state'").get()) return null;
    const row = this.db.prepare('SELECT document FROM review_state WHERE id=?').get(key); return row ? JSON.parse(row.document) : null;
  }
  participants(id) { return this.reviewState('participants:' + id)?.names ?? {}; }
  finalSpeakers(id) {
    const value = this.reviewState('final-speakers:' + id); let rows = null; const published = () => rows ??= this.publishedSegments(id);
    let current = value && ['complete', 'partial'].includes(value.phase)
      && [REVIEW_METHOD, REVIEW_METHOD + '-revalidated', ...PREVIOUS_METHODS].includes(value.method)
      ? value.source_guard === finalSourceGuard(this, id) ? value : this.keptSpeakers(id, value, published()) : null;
    const decisions = this.reviewState('speaker-decisions:' + id);
    if (current?.text_assignments && current.decision_version !== (decisions?.version ?? 0)) {
      const assigned = Object.values(current.text_assignments).filter(Boolean).length;
      current = { ...current, assignments: current.text_assignments, assigned, unresolved: current.assigned + current.unresolved - assigned };
    }
    if (current) current = { ...current, review_decision_version: current.decision_version };
    return decisionOverlay(current, decisions, published());
  }
  // A review whose sources changed keeps its names for the sentences it reviewed that are unchanged, until the meeting is
  // reviewed again; sentences published or changed since stay unresolved. 2026-11-24: a vocabulary update re-corrected and
  // published 2 to 9 held sentences in six meetings, and every name in those meetings disappeared until a new review.
  // Nothing is kept once the meeting's speaker roster, channel, committee or date changed after the review. A result saved
  // before sentence versions were recorded counts a sentence as changed when the correction log has an entry for it made
  // after the review began.
  keptSpeakers(id, value, rows) {
    const record = this.get(id); const roster = this.reviewState('speaker-roster:' + id);
    const rosterChanged = 'roster_version' in value ? (roster?.version ?? 0) !== value.roster_version
      : Boolean(roster?.version) && (roster.updated_ms ?? Infinity) >= (value.started_ms ?? 0);
    const meetingChanged = Array.isArray(value.meeting)
      && JSON.stringify(value.meeting) !== JSON.stringify([record?.stream_id ?? null, record?.committee ?? null, record?.scheduled_at ?? null]);
    if (rosterChanged || meetingChanged || !value.assignments) return null;
    const corrected = value.versions ? null : this.correctedSince(id, value.started_ms ?? 0);
    const same = row => Object.hasOwn(value.assignments, row.segment_id)
      && (value.versions ? value.versions[row.segment_id] === row.version : !corrected.has(row.segment_id));
    const keep = source => source ? Object.fromEntries(rows.map(row => [row.segment_id, same(row) ? source[row.segment_id] ?? null : null])) : undefined;
    const assignments = keep(value.assignments); const assigned = Object.values(assignments).filter(Boolean).length;
    if (!assigned) return null;
    return { ...value, phase: 'partial', kept: true, assignments, text_assignments: keep(value.text_assignments), assigned,
      unresolved: rows.length - assigned, acoustic_conflicts: (value.acoustic_conflicts ?? []).filter(item => assignments[item.segment_id]) };
  }
  // Sentences of a meeting with a correction made at or after a time. The correction log is kept at any age (src/retention.mjs).
  // CROSS JOIN keeps SQLite on the meeting's sessions and sentences instead of reading the whole log.
  correctedSince(id, since) {
    return new Set(this.db.prepare("SELECT DISTINCT c.segment_id AS id FROM broadcast_sessions b CROSS JOIN segments s ON s.session_id=b.session_id "
      + "CROSS JOIN corrections c ON c.segment_id=s.id WHERE b.broadcast_id=? AND json_extract(c.document,'$.created_ms')>=?").all(id, since).map(row => row.id));
  }
  // The fields that decide whether a stored speaker review is still current, read without parsing the whole result.
  finalSpeakersHead(id) {
    if (!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='review_state'").get()) return null;
    return this.db.prepare("SELECT json_extract(document,'$.phase') AS phase,json_extract(document,'$.method') AS method,"
      + "json_extract(document,'$.source_guard') AS source_guard,json_extract(document,'$.decision_version') AS decision_version,"
      + "json_extract(document,'$.people_hash') AS people_hash FROM review_state WHERE id=?").get('final-speakers:' + id) ?? null;
  }
  structuredCurrent(id, structured) {
    if (!structured) return false;
    if (structured.scope === 'published') return JSON.stringify(structured.revision) === JSON.stringify(this.publishedRevision(id));
    return structured.revision ? JSON.stringify(structured.revision) === JSON.stringify(this.revision(id))
      : structured.source_hash === createHash('sha256').update(JSON.stringify(this.segments(id).map(row => [row.segment_id, row.version]))).digest('hex');
  }
  summary(id) {
    const structured = this.reviewState('structured:' + id);
    if (!structured || structured.scope !== 'published' || !this.structuredCurrent(id, structured)) return null;
    const sources = new Map(structured.sources.map(part => [part.id, part]));
    const titles = new Map((structured.digest?.groups ?? []).map(group => [group.group, group.title]));
    const groups = [];
    structured.notes.forEach((note, group) => {
      const items = (note.summary ?? []).map(fact => {
        const source = sources.get(fact.source_id);
        return { text: fact.text, quote: fact.quote, source_id: fact.source_id, group, segment_id: source?.segment_id ?? null,
          session_id: source?.session_id ?? null, start_ms: Number.isFinite(source?.start_ms) ? source.start_ms : null };
      });
      if (items.length) groups.push({ group, title: titles.get(group) ?? '', items });
    });
    return { method: 'grounded_ai', model: structured.model, updated_ms: structured.updated_ms,
      items: groups.flatMap(group => group.items), groups, digest: structured.digest ?? null };
  }
  minutes(id) {
    const row = this.db.prepare('SELECT document FROM minutes WHERE broadcast_id=?').get(id);
    if (!row) return null;
    const value = JSON.parse(row.document);
    if (!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='review_state'").get()) return value;
    const read = key => { const row = this.db.prepare('SELECT document FROM review_state WHERE id=?').get(key + ':' + id); return row ? JSON.parse(row.document) : null; };
    const structured = read('structured'); const manual = read('manual');
    const current = this.structuredCurrent(id, structured);
    const reviewed = this.db.prepare("SELECT json_extract(document,'$.updated_ms') AS time FROM review_state WHERE id=?").get('final-speakers:' + id)?.time;
    return { ...value, structured: structured ? { ...structured, stale: !current } : null, manual,
      method: manual?.markdown ? 'manual_review' : current ? 'grounded_ai' : value.method,
      updated_ms: Math.max(value.updated_ms, structured?.updated_ms ?? 0, manual?.updated_ms ?? 0, reviewed ?? 0),
      markdown: manual?.markdown || (current && !this.finalSpeakers(id) ? structured.markdown : value.markdown) };
  }
  minuteList() {
    const reviewExists = Boolean(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='review_state'").get());
    return this.db.prepare("SELECT broadcast_id AS id,json_extract(document,'$.title') AS title,json_extract(document,'$.scheduled_at') AS scheduled_at,"
      + "json_extract(document,'$.status') AS status,json_extract(document,'$.updated_ms') AS updated_ms,json_extract(document,'$.segment_count') AS segment_count,"
      + "json_extract(document,'$.session_count') AS session_count FROM minutes ORDER BY rowid DESC").all().map(value => {
      if (reviewExists) {
        // The same sources as minutes(), so an unchanged meeting keeps the time it was last published with.
        const updated = this.db.prepare("SELECT max(json_extract(document,'$.updated_ms')) AS time FROM review_state WHERE id IN (?,?,?)")
          .get('structured:' + value.id, 'manual:' + value.id, 'final-speakers:' + value.id).time;
        value.updated_ms = Math.max(value.updated_ms, updated ?? 0);
      }
      return { id: value.id, title: value.title, scheduled_at: value.scheduled_at, status: value.status,
        updated_ms: value.updated_ms, segment_count: value.segment_count, session_count: value.session_count };
    });
  }
}
