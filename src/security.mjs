import { timingSafeEqual } from 'node:crypto';
import { HttpError } from './validate.mjs';

export class Security {
  constructor(config) { this.config = config; this.requests = new Map(); }
  authorize(req, admin) {
    const host = req.headers.host ?? '';
    if (!/^127\.0\.0\.1:\d+$/.test(host) && !/^localhost:\d+$/.test(host)) throw new HttpError(403, 'Invalid host');
    const origin = req.headers.origin;
    if (origin && origin !== 'http://' + host) throw new HttpError(403, 'Cross-origin request denied');
    const incoming = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const matches = expected => /^[a-f0-9]{64}$/.test(incoming) && expected && incoming.length === expected.length
      && timingSafeEqual(Buffer.from(incoming), Buffer.from(expected));
    const isAdmin = matches(this.config.adminToken);
    if (!isAdmin && (admin || !matches(this.config.viewerToken))) throw new HttpError(401, 'Authentication required');
    const key = isAdmin ? 'admin' : 'viewer';
    const minute = Math.floor(Date.now() / 60_000);
    const record = this.requests.get(key) ?? { minute, count: 0 };
    if (record.minute !== minute) { record.minute = minute; record.count = 0; }
    if (++record.count > (isAdmin ? 6000 : 6000)) throw new HttpError(429, 'Request limit');
    this.requests.set(key, record); return isAdmin;
  }
}
