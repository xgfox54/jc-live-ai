import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { boundedLog } from './bounded-log.mjs';

const unavailable = message => Object.assign(new Error(message), { code: 'ENGINE_UNAVAILABLE' });
export class WhisperEngine {
  constructor(config) {
    this.config = config; this.ready = false; this.pending = null; this.metadata = null;
    this.stopping = false; this.restartAttempts = 0;
  }
  async start() {
    if (this.stopping) throw unavailable('Engine stopped');
    const started = Date.now();
    this.log?.end(); this.log = boundedLog(this.config.engineLog);
    const child = spawn(this.config.worker, [this.config.model, String(this.config.beam), this.config.device,
      ...(this.config.flashAttention === true ? ['flash'] : [])],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    this.child = child;
    child.stderr.pipe(this.log);
    const ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.fail(unavailable('Model startup timeout')); child.kill();
      }, this.config.startupTimeoutMs ?? 180_000);
      this.startup = { resolve: value => { clearTimeout(timeout); resolve(value); },
        reject: error => { clearTimeout(timeout); reject(error); } };
    });
    const failed = error => {
      if (this.child !== child) return;
      this.fail(unavailable(error.message)); this.restart();
    };
    child.on('error', failed);
    child.on('exit', (code, signal) => failed(new Error(`Inference process exited: ${code ?? signal}`)));
    child.stdin.on('error', error => { failed(error); child.kill(); });
    createInterface({ input: child.stdout }).on('line', line => {
      if (this.child !== child || this.stopping) return;
      try {
        const reply = JSON.parse(line);
        if (reply.ready) {
          this.ready = true; this.metadata = { ...reply, startup_ms: Date.now() - started };
          this.startup.resolve(this.metadata); return;
        }
        if (reply.id !== this.pending?.id) return;
        const pending = this.pending; this.pending = null; clearTimeout(pending.timer);
        if (reply.error) pending.reject(new Error(reply.error));
        else { this.restartAttempts = 0; pending.resolve(reply); }
      } catch (error) { failed(new Error('Invalid inference reply', { cause: error })); child.kill(); }
    });
    return ready;
  }
  fail(error) {
    this.ready = false; this.startup?.reject(error);
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null; }
  }
  restart() {
    if (this.stopping || !this.metadata || this.restartTimer || this.restartAttempts >= (this.config.restartLimit ?? 8)) return;
    const delay = Math.min(this.config.restartMaxMs ?? 60_000,
      (this.config.restartBaseMs ?? 1000) * 2 ** this.restartAttempts++);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping) this.start().catch(() => this.restart());
    }, delay);
  }
  transcribe(job) {
    if (!this.ready || this.pending) return Promise.reject(unavailable('Engine unavailable'));
    return new Promise((resolve, reject) => {
      const id = randomUUID(); const child = this.child;
      const timer = setTimeout(() => {
        this.fail(unavailable('Inference deadline exceeded')); child.kill();
      }, this.config.inferenceTimeoutMs ?? 90_000);
      this.pending = { id, timer, resolve, reject };
      const decode = this.config.decode ? { decode: this.config.decode } : {};
      child.stdin.write(JSON.stringify({ id, pcm: job.pcm.toString('base64'), prompt: job.prompt, ...decode }) + '\n',
        error => { if (error) { this.fail(unavailable(error.message)); child.kill(); } });
    });
  }
  async stop() {
    this.stopping = true; clearTimeout(this.restartTimer);
    this.fail(unavailable('Engine stopped'));
    const child = this.child;
    if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) { this.log?.end(); return; }
    await new Promise(resolve => {
      const timer = setTimeout(() => child.kill(), 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
    });
    this.log?.end();
  }
}
export class EnginePool {
  constructor(config, count = config.workers ?? 1) {
    this.engines = Array.from({ length: count }, (_, index) =>
      new WhisperEngine(index ? { ...config, engineLog: config.engineLog + '.' + index } : config));
  }
  get capacity() { return this.engines.length; }
  get available() { return this.engines.filter(engine => engine.ready && !engine.pending).length; }
  get ready() { return this.engines.some(engine => engine.ready); }
  get metadata() { return this.engines[0].metadata && { ...this.engines[0].metadata, workers: this.engines.length }; }
  async start() { await Promise.all(this.engines.map(engine => engine.start())); return this.metadata; }
  transcribe(job) {
    const engine = this.engines.find(item => item.ready && !item.pending);
    return engine ? engine.transcribe(job) : Promise.reject(unavailable('Engine unavailable'));
  }
  async stop() { await Promise.all(this.engines.map(engine => engine.stop())); }
}
