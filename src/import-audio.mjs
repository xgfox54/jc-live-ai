import { mkdir, open, unlink } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { HttpError, text } from './validate.mjs';
import { CHANNEL_IDS } from '../public/committees.mjs';

export function mediaSignature(extension, head) {
  if (head.length < 12) return false;
  const ascii = (offset, value) => head.subarray(offset, offset + value.length).toString('latin1') === value;
  const mpeg = head[0] === 0xff && (head[1] & 0xe0) === 0xe0;
  switch (extension) {
    case '.wav': return ascii(0, 'RIFF') && ascii(8, 'WAVE');
    case '.mp3': return ascii(0, 'ID3') || mpeg;
    case '.aac': return ascii(0, 'ID3') || (head[0] === 0xff && (head[1] & 0xf6) === 0xf0);
    case '.m4a': case '.mp4': return ascii(4, 'ftyp');
    case '.webm': return head.readUInt32BE(0) === 0x1a45dfa3;
    case '.ogg': return ascii(0, 'OggS');
    case '.flac': return ascii(0, 'fLaC');
    default: return false;
  }
}
export async function importAudio(context, req, url) {
  const { scheduler, store, registry, inputs, minutes, config } = context;
  const id = url.searchParams.get('stream'); const name = text(url.searchParams.get('name'), 150);
  if (!CHANNEL_IDS.includes(id) || url.searchParams.get('approved') !== '1') throw new HttpError(400, '방송 슬롯과 파일 사용 권한을 확인해 주세요.');
  const extension = extname(name).toLowerCase();
  if (!['.wav', '.mp3', '.m4a', '.mp4', '.webm', '.ogg', '.flac', '.aac'].includes(extension)) throw new HttpError(400, '지원하는 음성·영상 파일을 선택해 주세요.');
  if (!scheduler.accepting || !scheduler.engine.ready || ['running', 'draining'].includes(scheduler.channels.get(id)?.state) || inputs.isActive?.(id)) throw new HttpError(409, '사용할 방송 슬롯의 처리를 먼저 마쳐 주세요.');
  const limit = 256 * 1024 * 1024;
  if (Number(req.headers['content-length']) > limit) throw new HttpError(413, '파일 한도는 256MiB입니다.');
  const folder = resolve(config.importDirectory ?? 'data/imports'); await mkdir(folder, { recursive: true });
  const file = resolve(folder, randomUUID() + extension); const handle = await open(file, 'wx'); let bytes = 0; let head = Buffer.alloc(0);
  try {
    for await (const part of req) {
      bytes += part.length; if (bytes > limit) throw new HttpError(413, '파일 한도는 256MiB입니다.');
      if (head.length < 16) head = Buffer.concat([head, part]).subarray(0, 16);
      await handle.writeFile(part);
    }
    await handle.close();
    if (!bytes) throw new HttpError(400, '빈 파일은 전사할 수 없습니다.');
    if (!mediaSignature(extension, head)) throw new HttpError(400, '파일 내용이 확장자와 맞지 않습니다. 원본 음성·영상 파일을 선택해 주세요.');
    if (['running', 'draining'].includes(scheduler.channels.get(id)?.state) || inputs.isActive?.(id)) throw new HttpError(409, '업로드 중 방송 슬롯 상태가 바뀌었습니다.');
    const broadcastId = createHash('sha256').update(file).digest('hex');
    registry.save({ id: broadcastId, title: name, sources: [], kind: 'file', phase: 'ended', completed: true, suspended: true, first_seen_ms: Date.now(), updated_ms: Date.now() });
    const stream = { stream_id: id, name, kind: 'file', page_url: '', video_id: null, broadcast_id: broadcastId,
      approved: true, approval_note: '관리자가 파일 사용 권한 확인 후 업로드', prompt: '', auto_start: false, auto_record: true };
    store.saveStream(stream); const state = scheduler.start(stream); minutes.attach(stream, state);
    inputs.start(stream, file, false, { local: true }).catch(() => {});
    return { broadcast_id: broadcastId, session_id: state.session_id, bytes, phase: 'transcribing' };
  } catch (error) { await handle.close().catch(() => {}); await unlink(file).catch(() => {}); throw error; }
}
