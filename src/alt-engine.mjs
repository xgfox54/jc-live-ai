import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundedLog } from './bounded-log.mjs';

// SHA-256 of SenseVoiceSmall 2024-07-17 model.onnx from the sherpa-onnx asr-models release.
export const senseVoiceHash = '977016bd9c79f9eb343430b5cc305e07ab64d5212dff41b0dcfa1694bee9a8cb';

// A second recognizer whose independent errors let the AI correction recover words the main recognizer drops.
export class AltEngine {
  constructor(config) { this.config = config; this.ready = false; this.tail = Promise.resolve(); this.queued = 0; this.metadata = null; }
  async start() {
    const directory = resolve(this.config.altDirectory ?? 'bin/sensevoice');
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(resolve(directory, 'model.onnx'))) hash.update(bytes);
    if (hash.digest('hex') !== senseVoiceHash) throw new Error('보조 음성 인식 모델 무결성 검사에 실패했습니다.');
    const threads = this.config.altThreads ?? 4;
    if (!Number.isInteger(threads) || threads < 1 || threads > 8) throw new Error('Invalid alternative recognizer threads');
    this.log = boundedLog(this.config.altLog ?? 'data/alt-recognizer.log');
    this.child = spawn(resolve(this.config.altPython ?? 'bin/sensevoice/venv/Scripts/python.exe'), ['-B', '-u', '-s',
      fileURLToPath(new URL('../worker/sensevoice_stream.py', import.meta.url)), directory, String(threads)],
    { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    this.child.stderr.pipe(this.log);
    const startup = new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => { this.fail(new Error('Alternative recognizer startup deadline exceeded')); this.child.kill(); }, 60000);
      this.startup = { resolve: value => { clearTimeout(timer); resolveReady(value); }, reject: error => { clearTimeout(timer); reject(error); } };
    });
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', () => this.fail(new Error('Alternative recognizer exited')));
    this.child.stdin.on('error', error => this.fail(error));
    createInterface({ input: this.child.stdout }).on('line', line => {
      try {
        const value = JSON.parse(line);
        if (value.ready) { this.ready = true; this.metadata = value; this.startup.resolve(value); return; }
        const pending = this.pending;
        if (!pending || value.id !== pending.id) throw new Error('Alternative recognizer reply identity mismatch');
        clearTimeout(pending.timer); this.pending = null;
        if (value.error) pending.reject(new Error(value.error));
        else if (typeof value.text !== 'string' || value.text.length > 5000) pending.reject(new Error('Invalid alternative recognizer reply'));
        else pending.resolve(value);
      } catch (error) { this.fail(error); this.child.kill(); }
    });
    return startup;
  }
  fail(error) {
    this.ready = false; this.startup?.reject(error);
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null; }
  }
  transcribe(job) {
    if (job.pcm.length === 0 || job.pcm.length > 960000 || job.pcm.length % 2) return Promise.reject(new Error('Invalid alternative recognizer audio'));
    if (this.queued >= 24) return Promise.reject(new Error('Alternative recognizer queue full'));
    this.queued++;
    const task = this.tail.then(() => {
      if (!this.ready) throw new Error('Alternative recognizer unavailable');
      return new Promise((resolveReply, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => { this.fail(new Error('Alternative recognizer deadline exceeded')); this.child.kill(); }, 30000);
        this.pending = { id, timer, resolve: resolveReply, reject };
        this.child.stdin.write(id + '\t' + job.pcm.toString('base64') + '\n', error => { if (error) this.fail(error); });
      });
    }).finally(() => { this.queued--; });
    this.tail = task.catch(() => {});
    return task;
  }
  async stop() {
    await this.tail;
    if (this.child?.pid && this.child.exitCode === null && this.child.signalCode === null) {
      const exited = once(this.child, 'exit'); this.child.stdin.end();
      const timer = setTimeout(() => this.child.kill(), 5000);
      await exited; clearTimeout(timer);
    }
    this.log?.end();
  }
}

