import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { speakerText, speakerKey } from '../public/speakers.mjs';
import { committeeForChannel } from '../public/committees.mjs';

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
  return '[' + (committee || '세션 ' + item.session_number) + ' / 구간 ' + item.epoch + ' / ' + time(item.start_ms) + '~' + time(item.end_ms)
    + (speakerText(item, participants) ? ' / ' + speakerText(item, participants) : '') + ']';
}
export function buildMinutes(record, sessions, segments, gaps, extras = {}) {
  const participants = extras.participants ?? {};
  const committee = clean(record.committee) || committeeForChannel(record.stream_id)?.name || '';
  const transcript = segments.map(segment => ({ segment_id: segment.segment_id,
    session_number: sessions.findIndex(session => session.session_id === segment.session_id) + 1,
    epoch: segment.timeline_epoch ?? 0, start_ms: segment.start_ms, end_ms: segment.end_ms,
    text: segment.corrected_text ?? segment.raw_text, ai_corrected: segment.ai_corrected === true,
    corrected: segment.corrected_text !== null && segment.corrected_text !== undefined, speaker_id: segment.speaker_id ?? null,
    speaker_key: speakerKey(segment),
    ...(segment.speaker_state ? { speaker_scope: segment.speaker_scope ?? null, speaker_state: segment.speaker_state,
      speaker_ids: [...new Set((segment.speaker_turns ?? []).filter(turn => turn.end_ms - turn.start_ms >= 200).map(turn => turn.speaker_id))] } : {}) }));
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
      named: Boolean(participants[item.speaker_key]), paragraph_count: 0, first_ms: item.start_ms, seconds: 0 };
    entry.paragraph_count++; entry.seconds += Math.max(0, (item.end_ms - item.start_ms) / 1000); speakers.set(item.speaker_key, entry);
  }
  const participantList = [...speakers.values()].sort((a, b) => a.first_ms - b.first_ms).map(entry => ({ ...entry, seconds: Math.round(entry.seconds) }));
  const summary = extras.summary ?? null;
  const active = sessions.some(session => ['running', 'draining', 'degraded', 'reconnecting'].includes(session.state));
  const warnings = ['AI 음성 전사에서 발언을 발췌한 검토용 회의록입니다. 발언자·참석자·정식 의결 결과는 원음과 공식 기록으로 확인해야 합니다.',
    '시각은 수집 세션과 입력 구간별 경과 시간입니다. 방송 영상의 시각과 일치 여부는 확인되지 않았습니다.',
    record.capture_from_start ? '방송 시작 부분부터 수집을 요청했습니다. 제공자의 다시보기·보관 구간에 따라 시작 부분이 누락될 수 있으며 전체 수록 여부는 확인되지 않았습니다.'
      : '수집 연결 이후의 음성으로 작성했습니다. 방송 시작부터 전체 수록했는지는 확인되지 않았습니다.'];
  if (gaps.length) warnings.push('음성·전사 누락 또는 입력 중단 기록 ' + gaps.length + '건이 있습니다. 원음 확인이 필요합니다.');
  if (record.beginning_fallback) warnings.push('시작 부분 수집에 실패해 현재 시점의 음성 수집으로 전환했습니다. 수집 사이의 누락 범위는 확인되지 않았습니다.');
  if (sessions.some(session => session.state === 'interrupted')) warnings.push('서버 재시작으로 중단된 수집 세션이 있습니다.');
  if (sessions.some(session => session.error)) warnings.push('수집 또는 전사 오류가 기록된 세션이 있습니다.');
  const started = sessions.map(session => session.started_ms).filter(Number.isFinite).sort((a, b) => a - b)[0];
  const value = { id: record.id, title: record.title, sources: record.sources,
    scheduled_at: clean(record.scheduled_at) || (started ? seoul(started) + ' (수집 시작 시각)' : ''), meeting_round: record.meeting_round ?? '', meeting_type: record.meeting_type ?? '',
    committee, agenda: record.agenda ?? '', status: active ? 'in_progress' : 'draft',
    method: 'extractive_transcript', updated_ms: Date.now(), segment_count: transcript.length,
    session_count: sessions.length, warnings, summary, discussion: ranked, participants: participantList, paragraphs, transcript,
    gaps: gaps.map(gap => ({ session_number: sessions.findIndex(session => session.session_id === gap.session_id) + 1,
      epoch: gap.timeline_epoch ?? 0, start_ms: gap.start_ms ?? null, end_ms: gap.end_ms ?? null, reason: gap.reason })) };
  const quote = item => '**' + minutesLabel(item, committee, participants) + '**  \n' + clean(item.text);
  const bySpeaker = participantList.map(entry => '### ' + entry.label + (entry.named ? ' (참여자 ' + entry.speaker_id + ')' : '') + ' · 발언 ' + entry.paragraph_count + '건\n\n'
    + paragraphs.filter(item => item.speaker_key === entry.key).map(quote).join('\n\n'));
  const unassigned = paragraphs.filter(item => !item.speaker_key);
  if (unassigned.length) bySpeaker.push('### 참여자 미확인·교대 구간 · ' + unassigned.length + '건\n\n' + unassigned.map(quote).join('\n\n'));
  value.markdown = '# ' + clean(value.title) + '\n\n작성 상태: ' + (active ? '수집·작성 중' : '검토용 초안') + '\n\n'
    + warnings.map(text => '- ' + text).join('\n') + '\n\n## 회의 정보\n\n'
    + [['일시', value.scheduled_at], ['회차', value.meeting_round], ['회의', value.meeting_type], ['소관', value.committee]]
      .map(([label, text]) => '- ' + label + ': ' + (clean(text) || '미확인')).join('\n')
    + '\n\n출처:\n' + value.sources.map(url => '- ' + url).join('\n')
    + '\n\n## 공식 심의 안건\n\n' + (value.agenda || '공식 페이지에서 안건을 확인하지 못했습니다.')
    + '\n\n## 주요 논의 요약\n\n' + (summary?.items?.length ? summary.items.map(item => '- ' + clean(item.text)).join('\n')
      : ranked.length ? 'AI 요약이 아직 생성되지 않아 받아쓰기에서 발췌한 문단을 표시합니다.\n\n' + ranked.map(quote).join('\n\n') : '요약할 발언이 아직 없습니다.')
    + '\n\n## 발언 내용 정리\n\n' + (bySpeaker.length ? '참여자 이름은 관리자가 지정한 경우에만 표시하며, 번호는 방송별 임시 번호입니다.\n\n' + bySpeaker.join('\n\n') : '정리할 발언이 아직 없습니다.')
    + '\n\n## 전체 회의록 받아쓰기\n\n' + (paragraphs.length ? paragraphs.map(quote).join('\n\n') : '전사 결과를 기다립니다.')
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
          { participants: this.registry.participants(id), summary: this.registry.summary(id) });
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
