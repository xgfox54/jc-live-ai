import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { BroadcastRegistry } from '../src/broadcast-registry.mjs';
import { CorrectionService } from '../src/ai-correction.mjs';

test('the automatic correction pass finds the candidates of one segment through an index', async () => {
  // Given the correction service on a new database
  const store = new Store(':memory:'); const registry = new BroadcastRegistry(store);
  const ai = new CorrectionService({ store, registry, scheduler: { states: () => [], channels: new Map() } });
  try {
    // When SQLite plans the lookup that auto() makes for every uncorrected segment (no broadcast in the condition)
    const plan = store.db.prepare('EXPLAIN QUERY PLAN SELECT 1 FROM ai_candidates c WHERE c.segment_id=? AND c.source_version=? AND c.context=?')
      .all('segment', 1, 'context').map(row => row.detail).join(' / ');
    // Then it searches an index; a scan read every candidate for each segment (about 6 seconds per pass on 23 November)
    assert.match(plan, /SEARCH c USING COVERING INDEX ai_candidate_segment/);
  } finally { await ai.close(); store.close(); }
});
