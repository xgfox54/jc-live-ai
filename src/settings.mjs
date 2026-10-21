import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from './validate.mjs';

const defaults = { chunkSeconds: 10, queueChunks: 12, silenceRms: 0, recordAudio: true, maxRecordingBytes: 1382400000, interim: false };
export function settingsView(config) {
  return { editable: Object.fromEntries(Object.keys(defaults).map(key => [key, config[key] ?? defaults[key]])),
    engine: { device: config.device, beam: config.beam, batch: config.batch, model: basename(config.model ?? ''), manual: config.manualMode === true } };
}
export function saveSettings(context, changes) {
  changes = { interim: context.config.interim ?? false, ...changes };
  if (Object.keys(changes).length !== Object.keys(defaults).length
    || Object.keys(changes).some(key => !Object.hasOwn(defaults, key))) throw new HttpError(400, '지원하지 않는 설정입니다.');
  if (![5, 10].includes(changes.chunkSeconds) || !Number.isInteger(changes.queueChunks)
    || changes.queueChunks < 2 || changes.queueChunks > 24 || typeof changes.recordAudio !== 'boolean' || typeof changes.interim !== 'boolean'
    || !Number.isFinite(changes.silenceRms) || changes.silenceRms < 0 || changes.silenceRms > 0.02
    || !Number.isSafeInteger(changes.maxRecordingBytes)
    || changes.maxRecordingBytes < 320000 || changes.maxRecordingBytes > 3200000000)
    throw new HttpError(400, '설정값의 허용 범위를 확인해 주세요.');
  if (context.scheduler.busy || [...context.scheduler.channels.values()].some(c => ['running', 'draining'].includes(c.state)))
    throw new HttpError(409, '모든 방송 수집과 남은 음성 처리를 마친 뒤 저장해 주세요.');
  if (!context.configPath) throw new HttpError(503, '이 실행 환경에서는 설정 저장을 지원하지 않습니다.');
  const saved = JSON.parse(readFileSync(context.configPath, 'utf8'));
  const temporary = context.configPath + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, JSON.stringify({ ...saved, ...changes }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, context.configPath);
  } finally { rmSync(temporary, { force: true }); }
  Object.assign(context.config, changes);
  return settingsView(context.config);
}
