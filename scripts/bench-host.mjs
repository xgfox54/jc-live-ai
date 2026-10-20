import { Store } from '../src/store.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { createService } from '../src/server.mjs';

let store; let service; let events = 0;
process.on('message', message => {
  if (message.action === 'start') {
    store = new Store(message.database);
    const engine = { ready: false, metadata: { synthetic_events_only: true }, stop: async () => {} };
    const scheduler = new Scheduler(store, engine, message.config);
    service = createService({ store, scheduler, config: message.config, inputs: {} });
    service.server.listen(0, '127.0.0.1', () => process.send({ ready: true, port: service.server.address().port }));
  }
  if (message.action === 'burst') {
    for (let round = 0; round < message.rounds; round++) for (let i = 1; i <= 8; i++) {
      const stream_id = 'ch' + i;
      const segment = store.segment({ stream_id, session_id: 'synthetic', timeline_epoch: 0,
        start_ms: events * 1000, end_ms: events * 1000 + 5000, raw_text: '합성 부하 시험 문장 ' + events + ' '.repeat(message.padding ?? 0) });
      store.correct(segment.segment_id, { version: 1, text: '합성 검토문 ' + events });
      store.event('status', { stream_id, state: 'synthetic' }); events += 3;
    }
    process.send({ action: 'burst', events, cursor: store.cursor(), memory: process.memoryUsage(), feed: service.feed.metrics });
  }
  if (message.action === 'metrics') process.send({ action: 'metrics', events, cursor: store.cursor(),
    memory: process.memoryUsage(), feed: { ...service.feed.metrics, active: service.feed.clients.size } });
  if (message.action === 'stop') service.close().then(() => { store.close(); process.disconnect(); });
});
