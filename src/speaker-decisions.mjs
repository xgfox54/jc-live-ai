import { createHash } from 'node:crypto';
import { HttpError } from './validate.mjs';
import { cosine } from './speaker-acoustics.mjs';
import { peopleCandidates } from './people-reference.mjs';

export const personIdentity = (person, evidence = {}) => ({ name: person.name, role: person.role, title: person.title ?? '',
  key: 'person-' + createHash('sha256').update(JSON.stringify(person.name)).digest('hex').slice(0, 24) + ':1', ...evidence });
export function decisionOverlay(result, decisions, rows) {
  const versions = new Map(rows.map(row => [row.segment_id, row.version]));
  const assignments = { ...(result?.assignments ?? {}) }; let changed = false;
  for (const [id, decision] of Object.entries(decisions?.entries ?? {})) {
    if (versions.get(id) !== decision.segment_version) continue;
    assignments[id] = decision.identity; changed = true;
  }
  if (!changed) return result;
  const assigned = rows.filter(row => assignments[row.segment_id]).length;
  return { ...result, method: result?.method ?? 'administrator-segment-review', assignments,
    phase: assigned === rows.length ? 'complete' : 'partial', assigned, unresolved: rows.length - assigned,
    decision_version: decisions.version, updated_ms: Math.max(result?.updated_ms ?? 0, decisions.updated_ms) };
}

export class SpeakerDecisions {
  constructor({ review, registry, store, directory }) {
    Object.assign(this, { review, registry, store, directory });
    store.db.exec('CREATE TABLE IF NOT EXISTS speaker_decision_history(broadcast_id TEXT NOT NULL,revision INTEGER NOT NULL,document TEXT NOT NULL,PRIMARY KEY(broadcast_id,revision));');
  }
  current(id) { this.review.record(id); return this.review.get('speaker-decisions:' + id) ?? { version: 0, entries: {} }; }
  state(id) {
    const record = this.review.record(id); const current = this.current(id); const acoustic = this.review.get('speaker-acoustics:' + id);
    const final = this.registry.finalSpeakers(id); const rows = this.registry.publishedSegments(id);
    const conflicts = new Map((final?.acoustic_conflicts ?? []).map(item => [item.segment_id, item.candidates]));
    return { version: current.version, analysis_version: acoustic?.signature ?? null,
      acoustic: acoustic ? { phase: acoustic.phase, method: acoustic.method, stats: acoustic.stats, missing: acoustic.missing.length } : null,
      candidates: peopleCandidates(record, this.directory, this.review.get('speaker-roster:' + id)?.people),
      total: rows.length, unresolved: rows.filter(row => !final?.assignments?.[row.segment_id]).length, conflicts: conflicts.size,
      items: rows.map(row => ({ segment_id: row.segment_id, version: row.version, session_id: row.session_id,
        start_ms: row.start_ms, end_ms: row.end_ms, text: row.corrected_text, identity: final?.assignments?.[row.segment_id] ?? null,
        conflict_candidates: conflicts.get(row.segment_id) ?? [],
        manual: Object.hasOwn(current.entries, row.segment_id) && current.entries[row.segment_id].segment_version === row.version })) };
  }
  preview(id, value) {
    this.review.record(id); const current = this.current(id);
    if (value.version !== current.version) throw new HttpError(409, '다른 관리자가 발언자를 변경했습니다. 목록을 다시 열어 주세요.');
    const rows = this.registry.publishedSegments(id); const source = rows.find(row => row.segment_id === value.segment_id);
    if (!source) throw new HttpError(404, '이 회의의 공개 받아쓰기 구간을 선택해 주세요.');
    if (value.segment_version !== source.version) throw new HttpError(409, '선택한 문장이 변경되었습니다. 다시 확인해 주세요.');
    if (!['one', 'similar', 'selected'].includes(value.mode)) throw new HttpError(400, '적용 범위를 선택해 주세요.');
    if (value.name !== null && (typeof value.name !== 'string' || !/^[가-힣A-Za-z· ]{2,40}$/.test(value.name.trim())
      || !['member', 'official', 'unknown'].includes(value.role))) throw new HttpError(400, '발언자 이름과 구분을 확인해 주세요.');
    const analysis = this.review.get('speaker-acoustics:' + id);
    if (value.mode !== 'one' && (!analysis || analysis.signature !== value.analysis_version)) throw new HttpError(409, '원음 분석 결과가 변경되었거나 없습니다. 분석 후 다시 확인해 주세요.');
    let ids = new Set([source.segment_id]);
    if (value.mode === 'selected') {
      if (!Array.isArray(value.segment_ids) || value.segment_ids.length > 200 || value.segment_ids.some(segment => typeof segment !== 'string' || !rows.some(row => row.segment_id === segment)))
        throw new HttpError(400, '이 회의의 구간을 최대 200개까지 선택해 주세요.');
      ids = new Set(value.segment_ids); ids.add(source.segment_id);
    }
    if (value.mode === 'similar') {
      const seed = analysis.features.find(feature => feature.segment_id === source.segment_id && feature.version === source.version);
      if (!seed || seed.mixed || seed.purity < .9 || seed.voiced_s < 3) throw new HttpError(409, '선택한 구간의 단독 발언 음성이 부족합니다. 한 구간만 확인하거나 다른 구간을 선택해 주세요.');
      const final = this.registry.finalSpeakers(id);
      for (const feature of analysis.features) {
        const row = rows.find(row => row.segment_id === feature.segment_id);
        const identity = final?.assignments?.[feature.segment_id];
        if (row?.version !== feature.version || feature.mixed || feature.purity < .9 || feature.voiced_s < 3
          || identity?.name && identity.name !== value.name?.trim() || current.entries[feature.segment_id]?.identity === null) continue;
        if (feature.cluster === seed.cluster && cosine(seed.vector, feature.vector) >= .86) ids.add(feature.segment_id);
      }
    }
    if (value.expected_segments && (!Array.isArray(value.expected_segments) || value.expected_segments.length > 200
      || value.expected_segments.some(expected => !expected || typeof expected !== 'object' || !ids.has(expected.segment_id)
        || !rows.some(row => row.segment_id === expected.segment_id && row.version === expected.version))))
      throw new HttpError(409, '미리보기 이후 문장이 변경되었습니다. 적용 구간을 다시 확인해 주세요.');
    const targets = rows.filter(row => ids.has(row.segment_id));
    if (value.expected_segments && value.expected_segments.length !== targets.length)
      throw new HttpError(409, '미리보기의 적용 범위를 다시 확인해 주세요.');
    const limited = value.mode === 'similar' && targets.length > 200;
    if (limited) {
      const others = targets.filter(row => row.segment_id !== source.segment_id).slice(0, 199);
      targets.splice(0, targets.length, source, ...others);
    }
    const confirmation = createHash('sha256').update(JSON.stringify([current.version, analysis?.signature, value.name, value.role,
      targets.map(row => [row.segment_id, row.version])])).digest('hex');
    return { version: current.version, analysis_version: analysis?.signature ?? null, confirmation, limited,
      name: value.name?.trim() ?? null, role: value.role ?? 'unknown',
      items: targets.map(row => ({ segment_id: row.segment_id, version: row.version, start_ms: row.start_ms, end_ms: row.end_ms, text: row.corrected_text })) };
  }
  apply(id, value) {
    const preview = this.preview(id, value); const current = this.current(id);
    if (value.confirmation !== preview.confirmation) throw new HttpError(409, '적용할 구간이 변경되었습니다. 적용 범위를 다시 확인해 주세요.');
    const entries = { ...current.entries };
    for (const row of preview.items) entries[row.segment_id] = { segment_version: row.version,
      identity: preview.name ? personIdentity({ name: preview.name, role: preview.role }, { method: 'administrator', evidence_id: value.segment_id }) : null };
    return this.save(id, current, entries, 'speakers.confirm');
  }
  undo(id, value) {
    const current = this.current(id);
    if (current.version !== value.version || !current.version) throw new HttpError(409, '변경 이력을 다시 불러와 주세요.');
    const previous = this.store.db.prepare('SELECT document FROM speaker_decision_history WHERE broadcast_id=? AND revision=?').get(id, current.version);
    if (!previous) throw new HttpError(409, '되돌릴 기록을 찾지 못했습니다.');
    return this.save(id, current, JSON.parse(previous.document).before.entries, 'speakers.undo');
  }
  save(id, before, entries, action) {
    const next = { version: before.version + 1, entries, updated_ms: Date.now() };
    this.store.transaction(() => {
      this.store.db.prepare('INSERT INTO speaker_decision_history VALUES(?,?,?)').run(id, next.version, JSON.stringify({ before, action, updated_ms: next.updated_ms }));
      this.review.save('speaker-decisions:' + id, next);
      this.store.audit({ action, broadcast_id: id, revision: next.version, segments: Object.keys(entries).length });
    });
    this.store.emit('broadcast', id); return { version: next.version };
  }
  roster(id, value) {
    const record = this.review.record(id); const previous = this.review.get('speaker-roster:' + id) ?? { version: 0, people: [] };
    if (!value) return { ...previous, candidates: peopleCandidates(record, this.directory, previous.people) };
    if (value.version !== previous.version) throw new HttpError(409, '참석자 목록이 변경되었습니다. 다시 열어 주세요.');
    if (!Array.isArray(value.people) || value.people.length > 160) throw new HttpError(400, '참석자는 최대 160명입니다.');
    const people = value.people.map(person => {
      if (!person || typeof person.name !== 'string' || !/^[가-힣A-Za-z· ]{2,40}$/.test(person.name.trim())
        || !['member', 'official', 'unknown'].includes(person.role) || typeof person.title !== 'string' || person.title.length > 80
        || !/^\d{4}-\d{2}-\d{2}$/.test(person.as_of ?? '') || !Number.isFinite(Date.parse(person.as_of))
        || typeof person.source !== 'string' || !person.source.trim() || person.source.length > 500)
        throw new HttpError(400, '이름·직책·회의 날짜·확인 근거를 입력해 주세요.');
      const date = String(record.scheduled_at ?? record.meeting_date ?? '').slice(0, 10);
      if (date && person.as_of !== date) throw new HttpError(400, '참석자 확인 날짜는 회의 날짜와 같아야 합니다.');
      return { name: person.name.trim(), role: person.role, title: person.title.trim(), as_of: person.as_of, source: person.source.trim(), attendance: true };
    });
    const next = { version: previous.version + 1, people, updated_ms: Date.now() };
    this.store.transaction(() => {
      this.review.save('speaker-roster-history:' + id + ':' + next.version, previous);
      this.review.save('speaker-roster:' + id, next); this.store.audit({ action: 'speakers.roster', broadcast_id: id, version: next.version });
    });
    this.store.emit('broadcast', id); return next;
  }
}
