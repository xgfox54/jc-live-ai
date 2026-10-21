import { gzipSync, gunzipSync } from 'node:zlib';

export class BlobStore {
  async read(path) {
    const { get } = await import('@vercel/blob');
    const result = await get(path, { access: 'private', useCache: false });
    if (!result) return null;
    if (result.statusCode !== 200 || !result.stream) throw new Error('Blob read failed');
    const raw = Buffer.from(await new Response(result.stream).arrayBuffer());
    const decoded = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw, { maxOutputLength: 64_000_000 }) : raw;
    const value = JSON.parse(decoded.toString('utf8'));
    return { value, etag: result.blob.etag };
  }
  async write(path, value, etag) {
    const { put } = await import('@vercel/blob');
    await put(path, gzipSync(Buffer.from(JSON.stringify(value))), { access: 'private', addRandomSuffix: false, allowOverwrite: true,
      contentType: 'application/gzip', cacheControlMaxAge: 60, ...(etag ? { ifMatch: etag } : {}) });
  }
}
