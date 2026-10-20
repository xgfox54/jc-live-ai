export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function integer(value, min, max) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new HttpError(400, 'Invalid integer');
  return number;
}
export function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new HttpError(400, 'Invalid identifier');
  return value;
}
export function text(value, max = 2000) {
  if (typeof value !== 'string' || value.length > max) throw new HttpError(400, 'Invalid text');
  return value;
}
export function sourcePage(value) {
  let url;
  try { url = new URL(text(value, 1000)); }
  catch { throw new HttpError(400, 'Invalid source URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new HttpError(400, 'HTTPS source required');
  const allowed = ['www.youtube.com', 'youtube.com', 'youtu.be', 'www.council.jeju.kr'];
  if (!allowed.includes(url.hostname)) throw new HttpError(400, 'Source host is not approved');
  if (url.hostname.endsWith('council.jeju.kr') && !url.pathname.startsWith('/broadcast/')) throw new HttpError(400, 'Broadcast page required');
  return url.href;
}
export function videoId(page) {
  if (!page) return null;
  const url = new URL(page);
  if (!['youtu.be','youtube.com','www.youtube.com'].includes(url.hostname)) return null;
  const id = url.hostname === 'youtu.be' ? url.pathname.slice(1) : url.searchParams.get('v') ?? url.pathname.match(/^\/(?:live|embed)\/([^/]+)$/)?.[1];
  return typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}
export async function body(req, limit = 128_000) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export async function jsonBody(req) {
  try {
    const parsed = JSON.parse((await body(req, 16_384)).toString());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'JSON object required');
    return parsed;
  }
  catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Invalid JSON');
  }
}
