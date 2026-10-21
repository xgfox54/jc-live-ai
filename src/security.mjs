import { timingSafeEqual } from 'node:crypto';
import { HttpError } from './validate.mjs';

export class Security {
  constructor(config, now = Date.now) { this.config = config; this.now = now; this.requests = new Map(); this.failures = { first: 0, count: 0 }; }
  checkOrigin(req) {
    const host = req.headers.host ?? '';
    if (!/^127\.0\.0\.1:\d+$/.test(host) && !/^localhost:\d+$/.test(host)) throw new HttpError(403, 'Invalid host');
    const origin = req.headers.origin;
    if (origin && origin !== 'http://' + host) throw new HttpError(403, 'Cross-origin request denied');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site request denied');
  }
  authorize(req, admin) {
    this.checkOrigin(req);
    const now = this.now();
    if (now - this.failures.first > 600_000) this.failures = { first: now, count: 0 };
    if (this.failures.count >= 10) throw new HttpError(429, '인증 실패가 반복되어 10분 동안 인증 요청을 제한합니다.');
    const incoming = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const matches = expected => /^[a-f0-9]{64}$/.test(incoming) && expected && incoming.length === expected.length
      && timingSafeEqual(Buffer.from(incoming), Buffer.from(expected));
    const isAdmin = matches(this.config.adminToken);
    if (!isAdmin && (admin || !matches(this.config.viewerToken))) {
      if (incoming) this.failures.count++;
      throw new HttpError(401, 'Authentication required');
    }
    const key = isAdmin ? 'admin' : 'viewer';
    const minute = Math.floor(now / 60_000);
    const record = this.requests.get(key) ?? { minute, count: 0 };
    if (record.minute !== minute) { record.minute = minute; record.count = 0; }
    if (++record.count > (isAdmin ? 6000 : 6000)) throw new HttpError(429, 'Request limit');
    this.requests.set(key, record); return isAdmin;
  }
}
