import { createServer } from 'node:http';
import { once } from 'node:events';
import { createViewer } from './viewer.mjs';
import { HttpError } from './validate.mjs';
import { desktopOrigin } from '../public/live-transport.mjs';

export function desktopLiveSettings(value) {
  if (!value || value.enabled === false) return null;
  if (value.enabled !== true || !Number.isSafeInteger(value.port) || value.port < 0 || value.port > 65535
    || !Array.isArray(value.allowedOrigins) || !value.allowedOrigins.length || value.allowedOrigins.length > 8)
    throw new Error('Invalid desktop live settings');
  return { port: value.port, publicOrigin: desktopOrigin(value.publicOrigin),
    allowedOrigins: value.allowedOrigins.map(origin => desktopOrigin(origin)) };
}

// This listener has no admin routes, credentials, file serving, or request forwarding.
export function createDesktopLive(context) {
  const settings = desktopLiveSettings(context.config.desktopLive);
  if (!settings) return null;
  const viewer = createViewer({ ...context, cloudSync: null, config: { ...context.config, maxClients: 350, snapshotCacheMs: 1000, pushDeliveryHealth: true } });
  const routes = new Set(['/api/viewer/snapshot', '/api/viewer/events', '/api/viewer/segments', '/api/viewer/schedule', '/api/viewer/status']);
  let windowStart = 0; let requests = 0;
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Vary', 'Origin');
    try {
      const host = req.headers.host ?? '';
      if (host !== new URL(settings.publicOrigin).host && !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) throw new HttpError(403, 'Host denied');
      if (!settings.allowedOrigins.includes(req.headers.origin)) throw new HttpError(403, 'Origin denied');
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      res.setHeader('Access-Control-Expose-Headers', 'ETag, Retry-After');
      if (req.url.length > 2048) throw new HttpError(414, 'Request too long');
      const url = new URL(req.url, 'http://127.0.0.1');
      if (!routes.has(url.pathname)) throw new HttpError(404, 'Route not found');
      if (Date.now() - windowStart >= 1000) { windowStart = Date.now(); requests = 0; }
      if (++requests > 1000) { res.setHeader('Retry-After', '2'); throw new HttpError(429, 'Request limit'); }
      if (req.method === 'OPTIONS') {
        const headers = (req.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
        if (req.headers['access-control-request-method'] !== 'GET' || headers.some(s => s !== 'if-none-match')) throw new HttpError(403, 'Preflight denied');
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'If-None-Match', 'Access-Control-Max-Age': '600' });
        res.end(); return;
      }
      if (req.method !== 'GET' || req.headers.authorization || req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) !== 0)
        throw new HttpError(405, 'Read-only endpoint');
      viewer.handle(req, res, url);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof HttpError ? error.status : 500;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: status === 500 ? 'Live service unavailable' : error.message }));
    }
  });
  server.maxConnections = 1024; server.headersTimeout = 10000; server.requestTimeout = 15000;
  return { server, feed: viewer.feed, settings,
    async start() { server.listen({ port: settings.port, host: '127.0.0.1', backlog: 1024 }); await once(server, 'listening'); },
    async close() {
      viewer.feed.close(); server.closeAllConnections();
      if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  };
}
