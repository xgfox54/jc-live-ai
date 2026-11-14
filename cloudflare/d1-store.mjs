import { gzipSync, gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { CloudError } from '../web/lib/model.mjs';

const validPath = path => path === 'site.json' || /^minutes\/[a-f0-9]{64}\.json$/.test(path);
const viewPath = path => path.replace(/\.json$/, '.view');
// The public minutes document is also kept compressed in its own row (path .view, same etag as its archive), so a viewer
// request is answered without decompressing and re-encoding the whole archive. That work exceeded the free plan's CPU
// time on a cold Worker (503 on the first request after a deploy, 2026-11-13).

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
    if (path !== 'site.json' && value.document) await this.saveView(path, next, gzipSync(Buffer.from(JSON.stringify(value.document))));
  }
  // Stored only while the archive row still has this etag, so a view never outlives its archive.
  async saveView(path, etag, body) {
    if (!validPath(path) || path === 'site.json') throw new CloudError(400, 'Invalid document path');
    await this.db.prepare('INSERT INTO documents(path, etag, body, updated_ms) SELECT ?, etag, ?, ? FROM documents WHERE path = ? AND etag = ? '
      + 'ON CONFLICT(path) DO UPDATE SET etag = excluded.etag, body = excluded.body, updated_ms = excluded.updated_ms')
      .bind(viewPath(path), Array.from(body), Date.now(), path, etag).run();
  }
  async readView(path) {
    if (!validPath(path) || path === 'site.json') throw new CloudError(400, 'Invalid document path');
    const row = await this.db.prepare('SELECT v.body FROM documents d JOIN documents v ON v.path = ? AND v.etag = d.etag WHERE d.path = ?')
      .bind(viewPath(path), path).first();
    return row ? new Uint8Array(row.body) : null;
  }
}
