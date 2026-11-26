import { HttpError, jsonBody, text } from './validate.mjs';
import { deliveryHealth } from './delivery-health.mjs';

const send = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
export async function reviewRequest(context, req, res, url) {
  if (!url.pathname.startsWith('/api/admin/workspace')) return false;
  const { review, audioReview, registry, scheduler, store, correctionAI, modelManager } = context;
  const id = url.searchParams.get('broadcast'); const action = url.pathname.slice('/api/admin/workspace'.length);
  if (req.method === 'GET') {
    switch (action) {
      case '': send(res, { items: registry.minuteList() }); return true;
      case '/state': send(res, review.view(id)); return true;
      case '/segment': {
        const item = review.sources(id).find(row => row.segment_id === url.searchParams.get('segment'));
        if (!item) throw new HttpError(404, '회의록 받아쓰기를 찾지 못했습니다.');
        send(res, item); return true;
      }
      case '/search': send(res, review.search(id, url.searchParams.get('q') ?? '', Number(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER), url.searchParams.get('repeats') === '1')); return true;
      case '/audio': {
        const wav = await audioReview.clip(url.searchParams.get('segment'));
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length }); res.end(wav); return true;
      }
      case '/recordings': send(res, { items: await audioReview.recordings(id), jobs: audioReview.jobs(id) }); return true;
      case '/export': {
        const kind = url.searchParams.get('kind') ?? 'json'; const value = review.export(id, kind);
        res.writeHead(200, { 'Content-Type': kind === 'json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
          'Content-Disposition': 'attachment; filename="transcript-' + id.slice(0, 12) + '-' + kind + (kind === 'json' ? '.json' : '.txt') + '"' });
        res.end(kind === 'json' ? JSON.stringify(value, null, 2) : value); return true;
      }
      case '/diagnostics': {
        // Explicit allowlist: no paths, transcript text, URL, credentials or account metadata.
        send(res, { product: 'JC-LIVE', version: '0.1.0', node: process.version, platform: process.platform, arch: process.arch,
          delivery: deliveryHealth(context, store.streams().map(stream => stream.stream_id), { admin: true }),
          engine: { device: scheduler.config?.device ?? null, ready: scheduler.engine.ready,
            beam: scheduler.config?.beam ?? null, batch: scheduler.config?.batch ?? null },
          sessions: scheduler.states().map(state => ({ state: state.state, queue_length: state.queue_length,
            total_received_s: state.total_received_s, total_processed_s: state.total_processed_s, total_gap_s: state.total_gap_s })),
          memory: process.memoryUsage(), ai: { provider: correctionAI.settings().provider, model: correctionAI.settings().model } }); return true;
      }
      case '/profiles': send(res, { items: correctionAI.profiles() }); return true;
      case '/participants': send(res, review.participants(id)); return true;
      case '/final-speakers': send(res, review.finalSpeakers.state(id)); return true;
      case '/speaker-review': send(res, review.speakerDecisions.state(id)); return true;
      case '/speaker-roster': send(res, review.speakerDecisions.roster(id)); return true;
      case '/video-alignment': send(res, review.videoAlignment.state(id)); return true;
      case '/replay-recovery': review.record(id); send(res, review.replayRecovery.state(id)); return true;
      case '/model-status': send(res, modelManager.status); return true;
      default: throw new HttpError(404, '작업 경로를 찾지 못했습니다.');
    }
  }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const value = await jsonBody(req);
  switch (action) {
    case '/minutes': send(res, review.edit(value.broadcast_id, value)); break;
    case '/generate': send(res, review.start(value.broadcast_id), 202); break;
    case '/pause': send(res, review.pause(value.broadcast_id)); break;
    case '/live': send(res, review.live(value.broadcast_id, value.enabled)); break;
    case '/retranscribe': send(res, await audioReview.start(value.broadcast_id, value), 202); break;
    case '/diarize': send(res, await audioReview.diarize(value.broadcast_id, value.session_id), 202); break;
    case '/pause-audio': send(res, audioReview.pause()); break;
    case '/speaker': send(res, store.speaker(text(value.segment_id, 80), value.version, value.speaker)); break;
    case '/participants': send(res, review.setParticipants(value.broadcast_id, value.names)); break;
    case '/final-speakers': send(res, review.finalSpeakers.start(value.broadcast_id), 202); break;
    case '/speaker-preview': send(res, review.speakerDecisions.preview(value.broadcast_id, value)); break;
    case '/speaker-confirm': send(res, review.speakerDecisions.apply(value.broadcast_id, value)); break;
    case '/speaker-undo': send(res, review.speakerDecisions.undo(value.broadcast_id, value)); break;
    case '/speaker-roster': send(res, review.speakerDecisions.roster(value.broadcast_id, value)); break;
    case '/video-alignment': send(res, review.videoAlignment.start(value.broadcast_id), 202); break;
    case '/replay-recovery': send(res, review.replayRecovery.start(value.broadcast_id, { dry: value.dry === true }), 202); break;
    case '/pause-final-speakers': send(res, review.finalSpeakers.pause(value.broadcast_id)); break;
    case '/profile-save': send(res, correctionAI.saveProfile(text(value.name, 100))); break;
    case '/profile-use': send(res, correctionAI.useProfile(text(value.id, 100))); break;
    case '/profile-delete': correctionAI.deleteProfile(text(value.id, 100)); send(res, { deleted: true }); break;
    case '/pull-model': send(res, modelManager.start(value.model), 202); break;
    case '/cancel-model': send(res, await modelManager.cancel()); break;
    case '/delete-model': send(res, await modelManager.remove(value.model)); break;
    default: throw new HttpError(404, '작업 경로를 찾지 못했습니다.');
  }
  return true;
}
