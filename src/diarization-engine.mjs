import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { boundedLog } from './bounded-log.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diarizationHash } from './diarization.mjs';

export class DiarizationEngine {
  constructor(config) {
    this.config = config; this.ready = false; this.tail = Promise.resolve(); this.queued = 0;
  }
  async start() {
    const directory = resolve(this.config.diarizationDirectory ?? 'bin/diarization');
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(resolve(directory, 'Nemotron-3-Diarization.q8_0.gguf'))) hash.update(bytes);
    if (hash.digest('hex') !== diarizationHash) throw new Error('화자분리 모델 무결성 검사에 실패했습니다.');
    const chunk = this.config.diarizationChunkFrames ?? 64;
    if (!Number.isInteger(chunk) || chunk < 6 || chunk > 125) throw new Error('Invalid diarization chunk geometry');
    this.log = boundedLog(this.config.diarizationLog ?? 'data/diarization.log');
    this.child = spawn(this.config.diarizationPython ?? 'python', ['-B', '-u', '-s',
      fileURLToPath(new URL('../worker/diarization_stream.py', import.meta.url)), directory, String(chunk)],
    { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.pipe(this.log);
    const startup = new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => { this.fail(new Error('Diarization startup deadline exceeded')); this.child.kill(); }, 60000);
      this.startup = { resolve: value => { clearTimeout(timer); resolveReady(value); }, reject: error => { clearTimeout(timer); reject(error); } };
    });
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', () => this.fail(new Error('Diarization process exited')));
    this.child.stdin.on('error', error => this.fail(error));
    createInterface({ input: this.child.stdout }).on('line', line => {
      try {
        if (line.length > 1000000) throw new Error('Diarization reply limit exceeded');
        const reply = JSON.parse(line);
        if (reply.ready && reply.speakers === 8) {
          this.ready = true; this.metadata = reply; this.startup.resolve(reply); return;
        }
        const pending = this.pending;
        if (!pending || reply.id !== pending.id) throw new Error('Diarization reply identity mismatch');
        clearTimeout(pending.timer); this.pending = null;
        if (reply.error) pending.reject(new Error(reply.error));
        else if (reply.key !== pending.key) { pending.reject(new Error('Diarization stream identity mismatch')); this.child.kill(); }
        else pending.resolve(reply);
      } catch (error) { this.fail(error); this.child.kill(); }
    });
    return startup;
  }
  fail(error) {
    this.ready = false; this.startup?.reject(error);
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null; }
  }
  request(operation, key, pcm = Buffer.alloc(0)) {
    if (!['open', 'push', 'finish', 'close'].includes(operation) || !/^[A-Za-z0-9_:-]{1,200}$/.test(key)
      || pcm.length > 352000 || pcm.length % 2) return Promise.reject(new Error('Invalid diarization request'));
    if (this.queued >= 24) return Promise.reject(new Error('Diarization request queue full'));
    this.queued++;
    const task = this.tail.then(() => {
      if (!this.ready) throw new Error('Diarization engine unavailable');
      return new Promise((resolveReply, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => { this.fail(new Error('Diarization inference deadline exceeded')); this.child.kill(); }, 30000);
        this.pending = { id, key, timer, resolve: resolveReply, reject };
        this.child.stdin.write([id, operation, key, pcm.toString('base64')].join('\t') + '\n', error => { if (error) this.fail(error); });
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
