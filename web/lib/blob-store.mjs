import { gzipSync, gunzipSync } from 'node:zlib';

// @vercel/blob 2.8.2 reads this process setting for each API request.
process.env.VERCEL_BLOB_RETRIES ??= '0';
export function blobRetryLimit(env = process.env) {
  const value = env.VERCEL_BLOB_RETRIES ?? '0';
  if (!/^[0-2]$/.test(value)) throw new Error('Blob retry configuration must be an integer from 0 to 2');
  return Number(value);
}

export class BlobStore {
  constructor({ sdk } = {}) { this.sdk = sdk; this.metrics = { read_attempts: 0, read_successes: 0, read_bytes: 0, write_attempts: 0, write_successes: 0, write_bytes: 0 }; }
  usage() { return { ...this.metrics, estimated_operations: this.metrics.read_attempts + this.metrics.write_attempts, billing_verified: false }; }
  async read(path) {
    blobRetryLimit();
    const { get } = this.sdk ?? await import('@vercel/blob');
    this.metrics.read_attempts++;
    const result = await get(path, { access: 'private', useCache: false });
    if (!result) { this.metrics.read_successes++; return null; }
    if (result.statusCode !== 200 || !result.stream) throw new Error('Blob read failed');
    const raw = Buffer.from(await new Response(result.stream).arrayBuffer());
    this.metrics.read_bytes += raw.length;
    const decoded = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw, { maxOutputLength: 64_000_000 }) : raw;
    const value = JSON.parse(decoded.toString('utf8'));
    this.metrics.read_successes++;
    return { value, etag: result.blob.etag };
  }
  async write(path, value, etag) {
    blobRetryLimit();
    const { put } = this.sdk ?? await import('@vercel/blob');
    const body = gzipSync(Buffer.from(JSON.stringify(value)));
    this.metrics.write_attempts++; this.metrics.write_bytes += body.length;
    await put(path, body, { access: 'private', multipart: false, addRandomSuffix: false, allowOverwrite: Boolean(etag),
      contentType: 'application/gzip', cacheControlMaxAge: 60, ...(etag ? { ifMatch: etag } : {}) });
    this.metrics.write_successes++;
  }
}
