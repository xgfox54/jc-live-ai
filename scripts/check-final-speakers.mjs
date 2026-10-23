import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.mjs';
import { BroadcastRegistry } from '../src/broadcast-registry.mjs';
import { CorrectionService } from '../src/ai-correction.mjs';
import { ReviewService } from '../src/review.mjs';
import { FinalSpeakerReview } from '../src/final-speakers.mjs';
import { buildMinutes } from '../src/minutes.mjs';

// Explicit diagnostic only: synthetic sentences, in-memory data, existing configured connection.
const config = JSON.parse(readFileSync('config.local.json', 'utf8'));
const source = new DatabaseSync(config.database, { readOnly: true });
const saved = source.prepare('SELECT id,document FROM ai_settings WHERE id IN (?,?)').all('global', 'proxy-credential'); source.close();
const adminToken = JSON.parse(readFileSync(config.tokenFile, 'utf8')).adminToken;
const store = new Store(':memory:'); const registry = new BroadcastRegistry(store);
const ai = new CorrectionService({ store, registry, scheduler: { states: () => [] }, config: { adminToken, manualMode: true } });
for (const row of saved) ai.save('ai_settings', row.id, JSON.parse(row.document));
if (ai.settings().provider !== 'proxy' || new URL(ai.settings().base).hostname !== '127.0.0.1') throw new Error('기존 로컬 프록시 연결만 사용할 수 있습니다.');
const record = registry.upsert({ title: '발언자 검증용 합성 문장', kind: 'file', page_url: 'local:final-review-fixture', sources: [] });
registry.attach({ stream_id: 'ch2', broadcast_id: record.id }, { session_id: 'fixture' });
store.saveSession({ stream_id: 'ch2', session_id: 'fixture', state: 'stopped', input_end_reason: 'eof', queue_length: 0 });
const fixtures = [
  ['이경심입니다. 오늘 회의를 시작하겠습니다.', 1, '이경심'],
  ['정다운입니다. 자료 제출을 요청합니다.', 1, '정다운'],
  ['이경심입니다. 요청한 자료를 제출해 주시기 바랍니다.', 3, '이경심'],
  ['이경심 위원의 발언을 참고했습니다.', 4, null],
];
for (const [index, [text, speaker]] of fixtures.entries()) {
  const row = store.segment({ stream_id: 'ch2', session_id: 'fixture', timeline_epoch: 0, start_ms: index * 10000, end_ms: (index + 1) * 10000,
    raw_text: text, speaker_scope: 'fixture', speaker_id: speaker, speaker_state: 'assigned' });
  store.correct(row.segment_id, { version: 1, text, origin: 'ai' });
}
const review = new ReviewService({ store, registry, correctionAI: ai }); const final = new FinalSpeakerReview({ registry, review, ai });
try {
  final.start(record.id); await final.pending;
  const result = registry.finalSpeakers(record.id); const rows = registry.segments(record.id);
  const checks = rows.map((row, index) => ({ expected: fixtures[index][2], actual: result?.assignments[row.segment_id]?.name ?? null }));
  const report = { fixture: 'synthetic-text-not-real-meeting', state: final.state(record.id), checks,
    passed: Boolean(result) && checks.every(check => check.expected === check.actual) };
  mkdirSync('reports/final-speakers-20261022', { recursive: true });
  writeFileSync('reports/final-speakers-20261022/model-check.json', JSON.stringify(report, null, 2));
  if (result) writeFileSync('reports/final-speakers-20261022/ui-fixture.json', JSON.stringify({ ...buildMinutes(registry.get(record.id), registry.sessions(record.id), rows, [], { finalSpeakers: result }), publication_policy: 'ai-corrected-v1' }, null, 2));
  console.log(JSON.stringify(report)); if (!report.passed) process.exitCode = 1;
} finally { await final.close(); await review.close(); await ai.close(); store.close(); }
