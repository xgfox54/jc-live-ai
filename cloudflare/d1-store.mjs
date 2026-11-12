import { gzipSync, gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { CloudError } from '../web/lib/model.mjs';

const validPath = path => path === 'site.json' || /^minutes\/[a-f0-9]{64}\.json$/.test(path);

export class D1Store {
  constructor(db) { this.db = db; }
  async read(path) {
    if (!validPath(path)) throw new CloudError(400, 'Invalid document path');
    const row = await this.db.prepare('SELECT etag, body FROM documents WHERE path = ?').bind(path).first();
    if (!row) return null;
    const body = Buffer.from(row.body);
    return { etag: row.etag, value: JSON.parse(gunzipSync(body, { maxOutputLength: 64_000_000 }).toString('utf8')) };
  }
  async write(path, value, etag) {
    if (!validPath(path)) throw new CloudError(400, 'Invalid document path');
    const body = gzipSync(Buffer.from(JSON.stringify(value)));
    if (body.length > 1_900_000) throw new CloudError(413, 'Archive exceeds free storage row limit', 'invalid');
    const next = randomUUID();
    const result = etag === undefined
      ? await this.db.prepare('INSERT INTO documents(path, etag, body, updated_ms) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO NOTHING')
        .bind(path, next, Array.from(body), Date.now()).run()
      : await this.db.prepare('UPDATE documents SET etag = ?, body = ?, updated_ms = ? WHERE path = ? AND etag = ?')
        .bind(next, Array.from(body), Date.now(), path, etag).run();
    if (result.meta.changes !== 1) throw new CloudError(409, 'Publication conflicts', 'conflict');
  }
}
