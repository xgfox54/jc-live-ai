import { readFileSync } from 'node:fs';
import { Store } from '../src/store.mjs';
import { BroadcastRegistry } from '../src/broadcast-registry.mjs';
import { AudioReview } from '../src/audio-review.mjs';
import { SpeakerAcoustics } from '../src/speaker-acoustics.mjs';
import { finalSourceHash } from '../src/final-speakers.mjs';

// Local analysis only: no collection, AI request, publication or transcript update.
const config = JSON.parse(readFileSync(process.argv[3] ?? 'config.local.json', 'utf8'));
const store = new Store(config.database); const registry = new BroadcastRegistry(store);
const id = process.argv[2]; if (!registry.get(id)) throw new Error('방송 기록을 확인해 주세요.');
const review = {
  get: key => registry.reviewState(key),
  save: (key, value) => store.db.prepare('INSERT INTO review_state VALUES(?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document').run(key, JSON.stringify(value)),
};
const scheduler = { states: () => store.states() };
const audioReview = new AudioReview({ store, registry, scheduler, config });
const acoustics = new SpeakerAcoustics({ registry, review, audioReview, config, scheduler });
const controller = new AbortController(); process.once('SIGINT', () => controller.abort());
try {
  const result = await acoustics.prepare(id, registry.publishedSegments(id), finalSourceHash(registry, id), controller.signal,
    value => process.stdout.write(JSON.stringify({ progress: value }) + '\n'));
  console.log(JSON.stringify({ phase: result.phase, features: result.features.length, missing: result.missing, stats: result.stats }));
} finally { await audioReview.close(); store.close(); }
