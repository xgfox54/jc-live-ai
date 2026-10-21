import { connectViewers, viewerSummary } from './viewer-client.mjs';
let viewers = [];
process.on('message', async message => {
  try {
    switch (message.action) {
      case 'connect': {
        const result = await connectViewers(message.base, message.token, message.count, message.publicFeed === true);
        viewers = result.viewers; process.send({ action: 'connect', connect_ms: result.connect_ms }); break;
      }
      case 'reconnect': {
        const start = Date.now(); viewers.forEach(v => v.close());
        await new Promise(resolve => setTimeout(resolve, 150));
        await Promise.all(viewers.map(v => v.connect()));
        process.send({ action: 'reconnect', reconnect_ms: Date.now() - start }); break;
      }
      case 'summary': {
        const missing = () => viewers.reduce((sum, v) => sum
          + message.segments.filter(s => v.versions.get(s.segment_id) !== s.version).length, 0);
        const deadline = Date.now() + 10000;
        while ((missing() > 0 || viewers.reduce((sum, v) => sum + v.count, 0) < (message.expected_events ?? 0))
          && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
        process.send({ action: 'summary', ...viewerSummary(viewers), missing_segment_versions: missing() }); break;
      }
      case 'stop': viewers.forEach(v => v.close()); process.disconnect(); break;
      default: throw new Error('Unknown viewer command');
    }
  } catch (error) { process.send({ error: error.message }); }
});
