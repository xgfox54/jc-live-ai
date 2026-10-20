import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';

export class WhisperEngine {
  constructor(config) { this.config = config; this.ready = false; this.pending = null; this.metadata = null; }
  async start() {
    const started = Date.now();
    this.log = createWriteStream(this.config.engineLog, { flags: 'a' });
    this.child = spawn(this.config.worker, [this.config.model, String(this.config.beam), this.config.device],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    this.child.stderr.pipe(this.log);
    const ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { reject(new Error('Model startup timeout')); this.child.kill(); }, 180_000);
      this.startup = { resolve: value => { clearTimeout(timeout); resolve(value); },
        reject: error => { clearTimeout(timeout); reject(error); } };
    });
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', (code, signal) => this.fail(new Error(`Inference process exited: ${code ?? signal}`)));
    createInterface({ input: this.child.stdout }).on('line', line => {
      try {
        const reply = JSON.parse(line);
        if (reply.ready) {
          this.ready = true; this.metadata = { ...reply, startup_ms: Date.now() - started };
          this.startup.resolve(this.metadata); return;
        }
        if (reply.id !== this.pending?.id) return;
        clearTimeout(this.pending.timer);
        if (reply.error) this.pending.reject(new Error(reply.error));
        else this.pending.resolve(reply);
        this.pending = null;
      } catch (error) { this.fail(new Error('Invalid inference reply', { cause: error })); this.child.kill(); }
    });
    return ready;
  }
  fail(error) {
    this.ready = false; this.startup?.reject(error);
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null; }
  }
  transcribe(job) {
    if (!this.ready || this.pending) return Promise.reject(new Error('Engine unavailable'));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { this.fail(new Error('Inference deadline exceeded')); this.child.kill(); }, 90_000);
      this.pending = { id, timer, resolve, reject };
      this.child.stdin.write(JSON.stringify({ id, pcm: job.pcm.toString('base64'), prompt: job.prompt }) + '\n',
        error => { if (error) this.fail(error); });
    });
  }
  async stop() {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) { this.log?.end(); return; }
    const exited = once(this.child, 'exit');
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 3000);
    await exited; clearTimeout(timer); this.log.end();
  }
}
