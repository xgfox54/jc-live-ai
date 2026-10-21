import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { EventFeed } from './events.mjs';
import { Security } from './security.mjs';
import { resolveCouncil, councilPage } from './council.mjs';
import { BroadcastMonitor, supportsAutoStart } from './broadcast-monitor.mjs';
import { createViewer, viewerStream } from './viewer.mjs';
import { settingsView, saveSettings } from './settings.mjs';
import { BroadcastRegistry } from './broadcast-registry.mjs';
import { BroadcastDiscovery } from './broadcast-discovery.mjs';
import { CouncilSchedule } from './council-schedule.mjs';
import { ArchiveEnricher } from './council-archive.mjs';
import { MinutesService } from './minutes.mjs';
import { minutesRequest } from './minutes-http.mjs';
import { CloudPublisher } from './cloud-publisher.mjs';
import { CorrectionService } from './ai-correction.mjs';
import { ReviewService } from './review.mjs';
import { AudioReview } from './audio-review.mjs';
import { reviewRequest } from './review-http.mjs';
import { importAudio } from './import-audio.mjs';
import { CaptureRecording } from './capture-recording.mjs';
import { ModelManager } from './model-manager.mjs';
import { committees, CHANNEL_IDS } from '../public/committees.mjs';
import { namedCommitteeStream } from './committees.mjs';
import { HttpError, identifier, integer, text, sourcePage, videoId, body, jsonBody } from './validate.mjs';

const staticFiles = new Map(['index.html', 'app.mjs', 'style.css', 'capture.mjs', 'pcm-worklet.mjs',
  'player.mjs', 'client-state.mjs', 'subscription.mjs', 'icon-192.png', 'logo-jc-live.png', 'admin.html', 'admin.mjs',
  'viewer-stage.mjs', 'transcripts.mjs', 'selection.mjs', 'admin-tools.mjs', 'automation.mjs',
  'minutes.html', 'minutes.mjs', 'polling.mjs', 'ai-tools.mjs', 'workspace.mjs', 'display.mjs',
  'JejuGothic-Regular.ttf', 'Pretendard-SemiBold.woff2', 'JejuGothic-OFL.txt', 'Pretendard-OFL.txt', 'speakers.mjs'].map(name => ['/' + name, new URL('../public/' + name, import.meta.url)]));
staticFiles.set('/minutes', new URL('../public/minutes.html', import.meta.url));
staticFiles.set('/admin', new URL('../public/admin.html', import.meta.url));
staticFiles.set('/admin/', new URL('../public/admin.html', import.meta.url));
for (const name of ['committees.mjs', 'committee-members.mjs', ...new Set(committees.flatMap(c => c.members.map(m => m.photo.slice(1))))])
  staticFiles.set('/' + name, new URL('../public/' + name, import.meta.url));
const json = (res, value, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value));
};
export function createService(context) {
  const { store, scheduler, inputs, config } = context;
  const security = new Security(config); const feed = new EventFeed(store, config);
  const registry = new BroadcastRegistry(store);
  const schedule = context.schedule ?? new CouncilSchedule();
  const minutes = new MinutesService({ registry, store, config });
  const viewer = createViewer({ ...context, registry, schedule });
  const monitor = new BroadcastMonitor({ ...context, registry, minutes });
  const discovery = new BroadcastDiscovery({ ...context, registry, monitor, archive: new ArchiveEnricher({ registry }) });
  const cloudSync = new CloudPublisher({ ...context, registry, minutes, schedule });
  const correctionAI = new CorrectionService({ ...context, registry });
  const review = new ReviewService({ store, registry, correctionAI });
  const audioReview = new AudioReview({ ...context, registry });
  const captureRecording = new CaptureRecording(context);
  const modelManager = new ModelManager(correctionAI);
  const states = () => [...new Map([...store.states(), ...scheduler.states()].map(item => [item.stream_id, item])).values()];
  const visibleStream = ({ approval_note, prompt, ...stream }) => stream;
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://www.youtube.com https://s.ytimg.com; frame-src https://www.youtube.com https://www.youtube-nocookie.com; connect-src 'self'; media-src 'self' blob:; style-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=(), usb=(), microphone=(self), display-capture=(self)');
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/viewer/')) {
        security.checkOrigin(req); viewer.handle(req, res, url); return;
      }
      if (req.method === 'GET' && (url.pathname === '/' || staticFiles.has(url.pathname))) {
        const file = staticFiles.get(url.pathname === '/' ? '/index.html' : url.pathname);
        const extension = fileURLToPath(file).split('.').at(-1);
        res.setHeader('Content-Type', { html: 'text/html; charset=utf-8', css: 'text/css', mjs: 'text/javascript', png: 'image/png', jpg: 'image/jpeg',
          ttf: 'font/ttf', woff2: 'font/woff2', txt: 'text/plain; charset=utf-8' }[extension]);
        res.end(await readFile(file)); return;
      }
      if (url.pathname === '/health/live') { json(res, { live: true }); return; }
      if (url.pathname === '/health/ready') {
        const ready = scheduler.engine.ready && scheduler.accepting && (!scheduler.diarizer || scheduler.diarizer.engine.ready);
        json(res, { ready }, ready ? 200 : 503); return;
      }
      security.authorize(req, true);
      if (req.method === 'POST') res.once('finish', () => process.stderr.write(JSON.stringify({ level: 'info', event: 'admin.action',
        method: req.method, path: url.pathname, status: res.statusCode, at: new Date().toISOString() }) + '\n'));
      if (url.pathname === '/api/admin/import' && req.method === 'POST') {
        json(res, await importAudio({ ...context, registry, minutes }, req, url), 202); return;
      }
      if (await reviewRequest({ review, audioReview, registry, scheduler, store, correctionAI, modelManager }, req, res, url)) return;
      if (url.pathname.startsWith('/api/admin/ai')) {
        const broadcast = url.searchParams.get('broadcast');
        if (req.method === 'GET') {
          if (url.pathname === '/api/admin/ai') { json(res, correctionAI.view()); return; }
          if (url.pathname === '/api/admin/ai/models') { json(res, await correctionAI.models()); return; }
          if (url.pathname === '/api/admin/ai/field') { json(res, correctionAI.field(broadcast)); return; }
          if (url.pathname === '/api/admin/ai/candidates') {
            json(res, correctionAI.list(broadcast, integer(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER))); return;
          }
        }
        if (req.method === 'POST') {
          const value = await jsonBody(req);
          switch (url.pathname) {
            case '/api/admin/ai/settings': json(res, correctionAI.saveSettings(value)); return;
            case '/api/admin/ai/field': json(res, correctionAI.saveField(value.broadcast_id, value)); return;
            case '/api/admin/ai/start': json(res, correctionAI.start(value.broadcast_id), 202); return;
            case '/api/admin/ai/cancel': json(res, await correctionAI.cancel(value.broadcast_id)); return;
            case '/api/admin/ai/apply': json(res, correctionAI.apply(value.id, value.acknowledge)); return;
            case '/api/admin/ai/reject': correctionAI.reject(value.id); json(res, { rejected: true }); return;
            case '/api/admin/ai/apply-safe': json(res, await correctionAI.applySafe(value.broadcast_id)); return;
          }
        }
        throw new HttpError(404, 'Route not found');
      }
      if (minutesRequest(registry, req, res, url, '/api/admin/minutes')) return;
      const ids = (url.searchParams.get('streams') ?? store.streams().map(s => s.stream_id).join(',')).split(',').filter(Boolean).map(identifier);
      if (ids.length > CHANNEL_IDS.length) throw new HttpError(400, 'Invalid channels');
      if (req.method === 'GET') {
        switch (url.pathname) {
          case '/api/admin/streams': json(res, { streams: store.streams(), states: states(), monitoring: monitor.states() }); return;
          case '/api/admin/settings': json(res, settingsView(config)); return;
          case '/api/admin/discovery': json(res, { ...discovery.view(), minutes_error: minutes.error ?? null, cloud_sync: cloudSync.view(), schedule: schedule.adminView() }); return;
          case '/api/streams': json(res, { streams: store.streams().map(visibleStream), states: states() }); return;
          case '/api/snapshot': {
            const snapshot = store.snapshot(ids); snapshot.streams = snapshot.streams.map(visibleStream);
            json(res, { ...snapshot, states: states().filter(s => ids.includes(s.stream_id)) }); return;
          }
          case '/api/segments':
            json(res, store.segments({ stream: identifier(url.searchParams.get('stream')),
              before: integer(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER),
              limit: integer(url.searchParams.get('limit') ?? 100, 1, 200),
              session: url.searchParams.get('session') ?? '' })); return;
          case '/api/events':
            feed.connect(req, res, ids, integer(url.searchParams.get('after') ?? 0, 0, Number.MAX_SAFE_INTEGER)); return;
          case '/api/admin/metrics':
            json(res, { ...scheduler.metrics, process: process.memoryUsage(), engine: scheduler.engine.metadata,
              states: scheduler.states(), samples: scheduler.samples, viewers: { ...feed.metrics,
                active: feed.clients.size + viewer.feed.clients.size } }); return;
          default: throw new HttpError(404, 'Route not found');
        }
      }
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
      if (url.pathname === '/api/admin/discovery') {
        const data = await jsonBody(req);
        if (typeof data.enabled !== 'boolean') throw new HttpError(400, '신규 주소 탐색 설정값을 확인해 주세요.');
        discovery.setEnabled(data.enabled); if (data.enabled) discovery.scan();
        json(res, discovery.view()); return;
      }
      if (url.pathname === '/api/admin/discovery/scan') {
        await discovery.scan(); json(res, discovery.view()); return;
      }
      if (url.pathname === '/api/admin/settings') {
        json(res, saveSettings(context, await jsonBody(req))); return;
      }
      if (url.pathname === '/api/admin/shutdown') {
        json(res, { draining: true }, 202);
        setImmediate(() => context.shutdown?.()); return;
      }
      if (url.pathname === '/api/admin/streams') {
        const data = await jsonBody(req); const id = identifier(data.stream_id);
        if (!CHANNEL_IDS.includes(id)) throw new HttpError(400, '등록된 위원회 채널을 선택해 주세요.');
        if (['running', 'draining'].includes(scheduler.channels.get(id)?.state)) throw new HttpError(409, 'Stop the stream before editing');
        if (data.approved !== true || !text(data.approval_note, 500).trim()) throw new HttpError(400, 'Source approval note required');
        const kind = data.kind;
        if (!['capture', 'file', 'youtube', 'council'].includes(kind)) throw new HttpError(400, 'Invalid source kind');
        const page_url = kind !== 'file' ? sourcePage(data.page_url) : '';
        if (kind === 'youtube' && (!videoId(page_url) || !config.ytdlp)) throw new HttpError(400, 'YouTube URL collector is not configured or video ID is missing');
        if (kind === 'file' && !config.files?.[id]) throw new HttpError(400, 'Local file must be configured by operator');
        if (data.auto_start !== undefined && typeof data.auto_start !== 'boolean') throw new HttpError(400, '자동 감지 설정값을 확인해 주세요.');
        const stream = namedCommitteeStream({ stream_id: id, name: text(data.name, 100), page_url, video_id: videoId(page_url),
          kind, approved: true, approval_note: text(data.approval_note, 500), prompt: text(data.prompt ?? '', 600) });
        stream.auto_start = supportsAutoStart(stream) && data.auto_start !== false;
        if (kind === 'council') {
          councilPage(page_url);
          try { Object.assign(stream, await resolveCouncil(page_url)); }
          catch (error) { if (!stream.auto_start) throw new HttpError(400, error.message); }
          if (stream.resolved_kind === 'youtube' && !config.ytdlp) throw new HttpError(400, 'YouTube collector is required for this council page');
        }
        if (['running', 'draining'].includes(scheduler.channels.get(id)?.state)) throw new HttpError(409, 'Stop the stream before editing');
        const previous = store.streams().find(item => item.stream_id === id);
        if (previous?.broadcast_id) registry.suspend(previous.broadcast_id, true);
        monitor.invalidate(id); store.saveStream(stream); store.event('stream', viewerStream(stream)); json(res, stream, 201); return;
      }
      const match = url.pathname.match(/^\/api\/admin\/streams\/(ch(?:[1-9]|1[0-2]))\/(start|stop|epoch|pcm|auto)$/);
      if (match) {
        const [, id, action] = match;
        const stream = store.streams().find(s => s.stream_id === id);
        if (!stream) throw new HttpError(404, 'Register source first');
        switch (action) {
          case 'start': {
            if (!stream.approved || stream.kind === 'pending') throw new HttpError(409, '사용 권한을 확인한 방송 주소를 먼저 등록해 주세요.');
            const state = monitor.begin(stream);
            json(res, state); return;
          }
          case 'auto': {
            const data = await jsonBody(req);
            json(res, monitor.setEnabled(stream, data.enabled)); return;
          }
          case 'stop':
            if (supportsAutoStart(stream)) monitor.setEnabled(stream, false);
            await inputs.stop(id);
            if (req.headers['x-capture-gap'] === '1') store.event('gap', {
              stream_id: id, session_id: scheduler.channel(id).session_id, reason: 'capture_transport_loss', extent: 'unknown'
            });
            json(res, scheduler.channels.has(id) ? scheduler.stop(id) : { stream_id: id, state: 'stopped' }); return;
          case 'epoch': json(res, scheduler.epoch(id)); return;
          case 'pcm': {
            if (stream.kind !== 'capture') throw new HttpError(409, 'File collector owns this stream');
            const packet = { session_id: identifier(req.headers['x-session']),
              epoch: integer(req.headers['x-epoch'], 0, Number.MAX_SAFE_INTEGER),
              seq: integer(req.headers['x-sequence'], 0, Number.MAX_SAFE_INTEGER), pcm: await body(req, 32_000) };
            const ack = scheduler.feed(id, packet); captureRecording.append(id, packet, ack); json(res, ack); return;
          }
        }
      }
      const correction = url.pathname.match(/^\/api\/admin\/segments\/([a-zA-Z0-9_-]+)$/);
      if (correction) {
        const data = await jsonBody(req);
        json(res, store.correct(correction[1], { version: integer(data.version, 1, 1_000_000), text: text(data.text, 5000) })); return;
      }
      throw new HttpError(404, 'Route not found');
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) process.stderr.write(JSON.stringify({ level: 'error', event: 'http.failure', error: error.message }) + '\n');
      json(res, { error: status === 500 ? 'Internal service error' : error.message }, status);
    }
  });
  server.maxConnections = 400; server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  return { server, feed, viewerFeed: viewer.feed, monitor, discovery, schedule, registry, minutes, cloudSync, correctionAI, review, audioReview, modelManager, async close() {
    await review.close(); await audioReview.close(); await modelManager.close();
    await discovery.close(); await monitor.close(); await correctionAI.close(); await cloudSync.close(); minutes.close();
    feed.close(); viewer.feed.close(); server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
