import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { open, mkdir, readFile, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { HttpError } from './validate.mjs';

export const diarizationHash = '08456d9e22cd9a323c0364d98375f3746d6e68507ebb705cd46438c534c7a3a1';
export function parseSpeakers(raw, duration) {
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!value || !Array.isArray(value.segments) || value.segments.length > 200000 || !Number.isFinite(duration) || duration <= 0)
    throw new Error('참여자 분석 결과 형식을 확인해 주세요.');
  for (const item of value.segments) if (!Number.isFinite(item.start) || !Number.isFinite(item.end)
    || item.start < 0 || item.end <= item.start || item.end > duration + .1 || !Number.isInteger(item.speaker) || item.speaker < 1 || item.speaker > 8)
    throw new Error('참여자 분석 결과의 시간·번호가 올바르지 않습니다.');
  return value.segments.map(({ start, end, speaker }) => ({ start, end, speaker }));
}
export async function nativeSpeakers(recording, config, signal) {
  const runtime = resolve(config.diarizationDirectory ?? 'bin/diarization');
  const model = resolve(runtime, 'Nemotron-3-Diarization.q8_0.gguf');
  const hasher = createHash('sha256');
  try { for await (const part of createReadStream(model)) hasher.update(part); }
  catch { throw new HttpError(503, '참여자 분석 모델을 찾지 못했습니다.'); }
  if (hasher.digest('hex') !== diarizationHash) throw new HttpError(503, '참여자 분석 모델 무결성 검사에 실패했습니다.');
  signal.throwIfAborted();
  const directory = resolve(config.analysisDirectory ?? 'data/analysis'); await mkdir(directory, { recursive: true });
  const wav = resolve(directory, randomUUID() + '.wav'); const output = await open(wav, 'wx');
  try {
    const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(recording.bytes + 36, 4); header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24);
    header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(recording.bytes, 40);
    await output.write(header);
    for await (const part of createReadStream(recording.file)) { signal.throwIfAborted(); await output.write(part); }
    await output.close();
    return await new Promise((resolveResult, reject) => {
      const child = spawn(resolve(runtime, 'nemo-speech.exe'), ['diarize', wav, '--model', model, '--backend', 'cpu', '--preset', 'v3-offline', '--format', 'json'],
        { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks = []; let size = 0; let error;
      const stop = () => { error = new Error('참여자 분석을 중단했습니다.'); child.kill(); };
      const timer = setTimeout(stop, 7200000); signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
      child.stdout.on('data', part => { size += part.length; if (size > 32 * 1024 * 1024) { error = new Error('참여자 분석 응답 한도를 초과했습니다.'); child.kill(); } else chunks.push(part); });
      child.once('error', failure => { error = failure; });
      child.once('close', code => {
        clearTimeout(timer); signal.removeEventListener('abort', stop);
        if (error || code !== 0) { reject(new Error('참여자 분석 실행에 실패했거나 중단됐습니다.')); return; }
        try { resolveResult(parseSpeakers(Buffer.concat(chunks).toString('utf8'), recording.bytes / 32000)); } catch (error) { reject(error); }
      });
    });
  } finally { await output.close().catch(() => {}); await unlink(wav).catch(() => {}); }
}
export function speakerFor(segment, spans) {
  const overlaps = new Map(); const start = segment.start_ms / 1000; const end = segment.end_ms / 1000;
  for (const span of spans) {
    const overlap = Math.max(0, Math.min(end, span.end) - Math.max(start, span.start));
    overlaps.set(span.speaker, (overlaps.get(span.speaker) ?? 0) + overlap);
  }
  const ranked = [...overlaps].sort((a, b) => b[1] - a[1]);
  return ranked[0]?.[1] >= (end - start) * .6 ? ranked[0][0] : null;
}
