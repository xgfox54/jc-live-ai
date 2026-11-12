import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { speakerText, speakerKey } from '../public/speakers.mjs';
import { committeeForChannel } from '../public/committees.mjs';
import { videoOffsets, videoShift } from './video-alignment.mjs';

const clean = value => String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
const time = ms => { const seconds = Math.floor(ms / 1000); return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, '0')).join(':'); };
const seoul = ms => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(ms);
const groupKey = item => item.speaker_id ? speakerKey(item) : item.speaker_state === 'multiple' ? 'multiple:' + (item.speaker_ids ?? []).join('.') : item.speaker_state ?? 'none';
export function paragraphsOf(transcript) {
  const paragraphs = [];
  for (const item of transcript) {
    const previous = paragraphs.at(-1);
    if (previous && previous.session_number === item.session_number && previous.epoch === item.epoch && item.start_ms - previous.end_ms <= 2000
      && previous.text.length < 1200 && groupKey(previous) === groupKey(item) && item.speaker_state !== 'pending') {
      previous.text += ' ' + item.text; previous.end_ms = item.end_ms; previous.segment_ids.push(item.segment_id);
    } else paragraphs.push({ ...item, segment_ids: [item.segment_id] });
  }
  return paragraphs;
}
export function minutesLabel(item, committee, participants = {}) {
  return '[' + (committee || '세션 ' + item.session_number) + ' / 구간 ' + item.epoch + ' / ' + (item.video_time ? '영상 ' : '') + time(item.start_ms) + '~' + time(item.end_ms)
    + (speakerText(item, participants) ? ' / ' + speakerText(item, participants) : '') + ']';
}
export function buildMinutes(record, sessions, segments, gaps, extras = {}) {
  const participants = extras.participants ?? {};
  const active = sessions.some(session => ['running', 'draining', 'degraded', 'reconnecting'].includes(session.state));
  const finalReview = active ? null : extras.finalSpeakers;
  // Channel 0 is not a committee: label its minutes with the official 소관 field or the broadcast title.
  const channel = committeeForChannel(record.stream_id);
  const committee = clean(record.committee) || (channel?.general ? clean(record.title) : channel?.name) || '';
  const transcript = segments.map(segment => ({ segment_id: segment.segment_id,
    session_number: sessions.findIndex(session => session.session_id === segment.session_id) + 1,
    epoch: segment.timeline_epoch ?? 0, start_ms: segment.start_ms, end_ms: segment.end_ms,
    text: segment.corrected_text ?? segment.raw_text, ai_corrected: segment.ai_corrected === true,
    corrected: segment.corrected_text !== null && segment.corrected_text !== undefined, speaker_id: segment.speaker_id ?? null,
    speaker_key: speakerKey(segment),
    ...(segment.speaker_state ? { speaker_scope: segment.speaker_scope ?? null, speaker_state: segment.speaker_state,
      speaker_ids: [...new Set((segment.speaker_turns ?? []).filter(turn => turn.end_ms - turn.start_ms >= 200).map(turn => turn.speaker_id))] } : {}) }));
  // Sessions matched against the official video audio are shown on the video's own clock.
  const offsets = videoOffsets(extras.videoAlignment, sessions, segments);
  const shiftOf = (sessionId, start_ms, end_ms) => { const entry = offsets.get(sessionId); return entry ? videoShift(entry, start_ms, end_ms) : null; };
  segments.forEach((segment, index) => {
    const offset = shiftOf(segment.session_id, segment.start_ms, segment.end_ms) ?? segment.video_offset_ms; if (!Number.isFinite(offset)) return;
    const item = transcript[index]; item.start_ms += offset; item.end_ms += offset; item.video_time = true;
  });
  for (const item of transcript) {
    if (!active) item.speaker_final = true;
    if (!finalReview) continue;
    const identity = finalReview.assignments[item.segment_id];
    item.speaker_name = identity?.name ?? null; item.speaker_role = identity?.role ?? null;
    item.speaker_key = identity?.key ?? null;
    // Final identity is a separate overlay; stored diarization and raw text are unchanged.
    item.speaker_id = identity ? 1 + parseInt(identity.key.slice(7, 9), 16) % 8 : null;
  }
  const paragraphs = paragraphsOf(transcript);
  const words = new Map();
  for (const item of paragraphs) for (const word of new Set(item.text.match(/[가-힣]{2,}|[A-Za-z]{3,}/g) ?? []))
    words.set(word, (words.get(word) ?? 0) + 1);
  const ranked = paragraphs.map((item, index) => ({ item, index, score:
    [...new Set(item.text.match(/[가-힣]{2,}|[A-Za-z]{3,}/g) ?? [])].reduce((sum, word) => sum + Math.log(1 + (words.get(word) ?? 0)), 0) / Math.sqrt(Math.max(item.text.length, 1)) }))
    .filter(value => value.item.text.length >= 12).sort((a, b) => b.score - a.score).slice(0, 20).sort((a, b) => a.index - b.index).map(value => value.item);
  const speakers = new Map();
  for (const item of paragraphs) {
    if (!item.speaker_key) continue;
    const entry = speakers.get(item.speaker_key) ?? { key: item.speaker_key, speaker_id: item.speaker_id, label: speakerText(item, participants),
      named: Boolean(item.speaker_name || participants[item.speaker_key]), speaker_name: item.speaker_name ?? null,
      speaker_role: item.speaker_role ?? null, speaker_final: !active, paragraph_count: 0, first_ms: item.start_ms, seconds: 0 };
    entry.paragraph_count++; entry.seconds += Math.max(0, (item.end_ms - item.start_ms) / 1000); speakers.set(item.speaker_key, entry);
  }
  const participantList = [...speakers.values()].sort((a, b) => a.first_ms - b.first_ms).map(entry => ({ ...entry, seconds: Math.round(entry.seconds) }));
  const summary = extras.summary ?? null;
  const sessionNumber = sessionId => sessions.findIndex(session => session.session_id === sessionId) + 1;
  // Time-ordered summary groups: one group per AI batch that produced grounded summary facts.
  const timeline = (summary?.groups ?? []).map(group => {
    const timed = group.items.filter(item => Number.isFinite(item.start_ms)).map(item => ({ item, offset: shiftOf(item.session_id, item.start_ms, item.start_ms) }));
    const video_time = timed.length > 0 && timed.every(entry => entry.offset !== null);
    const starts = timed.map(({ item, offset }) => item.start_ms + (video_time ? offset : 0));
    return { group: group.group, title: clean(group.title), session_number: sessionNumber(group.items[0]?.session_id),
      start_ms: starts.length ? Math.min(...starts) : 0, video_time,
      items: group.items.map(item => ({ text: item.text, quote: item.quote, segment_id: item.segment_id ?? null })) };
  }).filter(group => group.items.length).sort((a, b) => a.session_number - b.session_number || a.start_ms - b.start_ms);
  const digest = summary?.digest ? { overview: summary.digest.overview, topics: summary.digest.topics } : null;
  const videoItems = transcript.filter(item => item.video_time).length;
  const warnings = ['AI 음성 전사에서 발언을 발췌한 검토용 회의록입니다. 발언자·참석자·정식 의결 결과는 원음과 공식 기록으로 확인해야 합니다.',
    videoItems && videoItems === transcript.length ? '시각은 공식 영상의 재생 위치입니다. 녹음 음성과 공식 영상 음성을 대조해 세션별로 맞췄습니다.'
      : videoItems ? '"영상"으로 표시한 시각은 공식 영상의 재생 위치이고, 나머지는 수집 세션별 경과 시간입니다.'
        : '시각은 수집 세션과 입력 구간별 경과 시간입니다. 방송 영상의 시각과 일치 여부는 확인되지 않았습니다.',
    record.capture_from_start ? '방송 시작 부분부터 수집을 요청했습니다. 제공자의 다시보기·보관 구간에 따라 시작 부분이 누락될 수 있으며 전체 수록 여부는 확인되지 않았습니다.'
      : '수집 연결 이후의 음성으로 작성했습니다. 방송 시작부터 전체 수록했는지는 확인되지 않았습니다.'];
  if (gaps.length) warnings.push('음성·전사 누락 또는 입력 중단 기록 ' + gaps.length + '건이 있습니다. 원음 확인이 필요합니다.');
  if (record.beginning_fallback) warnings.push('시작 부분 수집에 실패해 현재 시점의 음성 수집으로 전환했습니다. 수집 사이의 누락 범위는 확인되지 않았습니다.');
  // Rows merged from another PC's record carry a note on their source and clock (2026-11-11 plenary).
  if (record.merge_note) warnings.push(clean(record.merge_note));
  if (sessions.some(session => session.state === 'interrupted')) warnings.push('서버 재시작으로 중단된 수집 세션이 있습니다.');
  if (sessions.some(session => session.error)) warnings.push('수집 또는 전사 오류가 기록된 세션이 있습니다.');
  const started = sessions.map(session => session.started_ms).filter(Number.isFinite).sort((a, b) => a - b)[0];
  // The council replay goes in its own field so readers that only know the YouTube form keep accepting the document.
  const alignment = extras.videoAlignment; const aligned = [...offsets].map(([sessionId, entry]) => ({ session_number: sessionNumber(sessionId), offset_ms: entry.offset_ms }));
  const value = { id: record.id, title: record.title, sources: record.sources,
    scheduled_at: clean(record.scheduled_at) || (started ? seoul(started) + ' (수집 시작 시각)' : ''), meeting_round: record.meeting_round ?? '', meeting_type: record.meeting_type ?? '',
    committee, agenda: record.agenda ?? '', status: active ? 'in_progress' : 'draft',
    method: 'extractive_transcript', updated_ms: Date.now(), segment_count: transcript.length,
    // Earlier site versions accept only non-negative offsets in video_alignment.
    video_alignment: offsets.size && alignment.video_id ? { video_id: alignment.video_id, sessions: aligned.filter(item => item.offset_ms >= 0) } : null,
    replay: offsets.size && alignment.media_url ? { media_url: alignment.media_url, page_url: alignment.page_url ?? null, sessions: aligned } : null,
    session_count: sessions.length, warnings, summary, digest, timeline, discussion: ranked, participants: participantList, paragraphs, transcript,
    final_speakers: finalReview ? { phase: finalReview.phase, assigned: finalReview.assigned, unresolved: finalReview.unresolved, updated_ms: finalReview.updated_ms }
      : { phase: active ? 'live' : 'pending', assigned: 0, unresolved: transcript.length, updated_ms: 0 },
    gaps: gaps.map(gap => {
      const offset = (gap.timeline_epoch ?? 0) === 0 && gap.start_ms != null ? shiftOf(gap.session_id, gap.start_ms, gap.end_ms ?? gap.start_ms) ?? 0 : 0;
      return { session_number: sessions.findIndex(session => session.session_id === gap.session_id) + 1, epoch: gap.timeline_epoch ?? 0,
        start_ms: gap.start_ms == null ? null : gap.start_ms + offset, end_ms: gap.end_ms == null ? null : gap.end_ms + offset, reason: gap.reason };
    }) };
  const quote = item => '**' + minutesLabel(item, committee, participants) + '**  \n' + clean(item.text);
  const role = entry => entry.speaker_role === 'member' ? ' 의원' : entry.speaker_role === 'official' ? ' (공무원)' : '';
  const fact = item => '- ' + clean(item.text) + (item.evidence?.length ? '\n  근거: ' + clean(item.evidence[0].quote) : item.quote ? '\n  근거: ' + clean(item.quote) : '');
  const speakerLines = participantList.map(entry => '- ' + entry.label + role(entry) + ' · 발언 ' + entry.paragraph_count + '건 · 약 ' + Math.round(entry.seconds / 60) + '분');
  const unassigned = paragraphs.filter(item => !item.speaker_key).length;
  if (unassigned) speakerLines.push('- 발언자 미확인·교대 구간 · ' + unassigned + '건');
  const speakerNote = finalReview ? '전체 발언 구간을 재검토했습니다. 이름을 뒷받침할 근거가 부족한 구간은 발언자 미확인으로 남깁니다.'
    : active ? '번호는 실시간 분석의 임시 번호입니다. 회의가 끝나면 발언자를 자동으로 재검토합니다.' : '회의가 끝나 발언자 재검토를 기다리고 있습니다.';
  const chapter = digest ? '### 회의 한줄 요약\n\n' + clean(digest.overview.text) + '\n\n### 주요 논의 사항\n\n'
    + digest.topics.map(topic => '#### ' + clean(topic.title) + '\n\n' + topic.items.map(fact).join('\n')).join('\n\n')
    : timeline.length ? 'AI 전체 요약을 아직 만들지 않았습니다. 핵심 내용 요약에서 시간순 요약을 확인해 주세요.' : active ? '수집 중입니다. 후보정이 완료된 발언으로 요약을 작성합니다.' : '요약할 발언이 아직 없습니다.';
  const keyPoints = timeline.length ? timeline.map(group => '### ' + (value.session_count > 1 ? '세션 ' + group.session_number + ' · ' : '') + time(group.start_ms)
    + (group.title ? ' · ' + group.title : '') + '\n\n' + group.items.map(fact).join('\n')).join('\n\n')
    : active ? '수집 중입니다. 후보정이 완료된 발언으로 요약을 작성합니다.' : '요약할 발언이 아직 없습니다.';
  value.markdown = '# ' + clean(value.title) + '\n\n작성 상태: ' + (active ? '수집·작성 중' : '검토용 초안') + '\n\n'
    + warnings.map(text => '- ' + text).join('\n') + '\n\n## 회의 정보\n\n'
    + [['일시', value.scheduled_at], ['회차', value.meeting_round], ['회의', value.meeting_type], ['소관', value.committee],
      ['발언자', participantList.length + '명' + (unassigned ? ' · 미확인 구간 ' + unassigned + '건' : '')], ['받아쓰기', transcript.length + '개 구간 · ' + paragraphs.length + '개 문단']]
      .map(([label, text]) => '- ' + label + ': ' + (clean(text) || '미확인')).join('\n')
    + '\n\n출처:\n' + value.sources.map(url => '- ' + url).join('\n')
    + '\n\n공식 심의 안건:\n' + (value.agenda || '공식 페이지에서 안건을 확인하지 못했습니다.')
    + '\n\n## 1장 회의록\n\n' + chapter
    + '\n\n### 발언자\n\n' + (speakerLines.length ? speakerNote + '\n\n' + speakerLines.join('\n') : '정리할 발언이 아직 없습니다.')
    + '\n\n## 핵심 내용 요약\n\n' + keyPoints
    + '\n\n## 전체 회의 받아쓰기 기록\n\n' + (paragraphs.length ? paragraphs.map(quote).join('\n\n') : '전사 결과를 기다립니다.')
    + '\n\n## 누락·중단 기록\n\n' + (value.gaps.length ? value.gaps.map(gap => '- 세션 ' + gap.session_number
      + ' / 구간 ' + gap.epoch + ' / ' + (gap.start_ms === null ? '범위 미확인' : time(gap.start_ms) + '~' + time(gap.end_ms ?? gap.start_ms))
      + ' / ' + gap.reason).join('\n') : '기록된 누락·중단이 없습니다. 전체 수록을 보장하는 의미는 아닙니다.') + '\n';
  return value;
}
export class MinutesService {
  constructor({ registry, store, config, review }) {
    Object.assign(this, { registry, store, config, review }); this.dirty = new Set(); this.errors = new Map();
    this.listener = event => {
      if (!['segment', 'session', 'gap'].includes(event.kind)) return;
      const id = registry.forSession(event.payload.session_id); if (id) this.dirty.add(id);
    };
    store.on('event', this.listener);
    this.broadcastListener = id => this.dirty.add(id); store.on('broadcast', this.broadcastListener);
    for (const record of registry.list()) if (registry.sessions(record.id).length) this.dirty.add(record.id);
    this.timer = setInterval(() => this.flush(), 10000); this.timer.unref(); this.flush();
  }
  attach(stream, session) { const id = this.registry.attach(stream, session); this.dirty.add(id); return id; }
  get error() { return this.errors.values().next().value ?? null; }
  flush() {
    for (const id of [...this.dirty]) {
      try {
        const record = this.registry.get(id); if (!record) { this.dirty.delete(id); this.errors.delete(id); continue; }
        const sessions = this.registry.sessions(id);
        if (!sessions.length) { this.dirty.delete(id); continue; }
        const value = buildMinutes(record, sessions, this.registry.segments(id), this.registry.gaps(id),
          { participants: this.registry.participants(id), summary: this.registry.summary(id), finalSpeakers: this.registry.finalSpeakers(id),
            videoAlignment: this.registry.reviewState('video-alignment:' + id) });
        this.registry.saveMinutes(value);
        const directory = resolve(this.config.minutesDirectory ?? 'data/minutes'); mkdirSync(directory, { recursive: true });
        for (const [extension, data] of [['md', value.markdown], ['json', JSON.stringify(value, null, 2)]]) {
          const path = resolve(directory, id + '.' + extension); writeFileSync(path + '.tmp', data, { mode: 0o600 }); renameSync(path + '.tmp', path);
        }
        this.dirty.delete(id); this.errors.delete(id);
      } catch (error) { this.errors.set(id, error.message); }
    }
  }
  close() { clearInterval(this.timer); this.store.off('event', this.listener); this.store.off('broadcast', this.broadcastListener); this.flush(); }
}
