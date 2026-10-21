import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { HttpError } from './validate.mjs';

export function proxyBase(value) {
  if (typeof value !== 'string' || value.length > 1000 || /\s/.test(value)) throw new HttpError(400, '프록시 주소를 확인해 주세요.');
  let url; try { url = new URL(value); } catch { throw new HttpError(400, '프록시 주소를 확인해 주세요.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash)
    throw new HttpError(400, '외부 프록시는 HTTPS가 필요합니다. HTTP는 이 PC의 루프백 주소만 허용합니다.');
  if (/^(?:0\.|169\.254\.)|^\[(?:::|fe[89ab][0-9a-f]?:|::ffff:(?:0:|a9fe:|169\.254\.))/.test(url.hostname)
    || ['metadata', 'metadata.google.internal'].includes(url.hostname.toLowerCase()))
    throw new HttpError(400, '링크 로컬·메타데이터 주소는 프록시로 사용할 수 없습니다.');
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url.href.replace(/\/+$/, '');
}
export function sealCredential(secret, destination, token) {
  if (!/^[a-f0-9]{64}$/.test(token ?? '')) throw new HttpError(503, '서버 인증 설정을 확인해 주세요.');
  const key = createHash('sha256').update('JC-LIVE proxy credential\0' + token).digest();
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(destination));
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return { destination, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), value: encrypted.toString('base64') };
}
export function openCredential(value, destination, token) {
  if (!value) return '';
  if (value.destination !== destination) throw new HttpError(409, '프록시 주소가 변경되었습니다. 연결 인증키를 다시 저장해 주세요.');
  try {
    const key = createHash('sha256').update('JC-LIVE proxy credential\0' + token).digest();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
    decipher.setAAD(Buffer.from(destination)); decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(value.value, 'base64')), decipher.final()]).toString('utf8');
  } catch { throw new HttpError(503, '프록시 인증키를 다시 저장해 주세요.'); }
}
