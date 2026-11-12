import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { stopProcessTree } from './subprocess.mjs';

export class AcousticVad {
  constructor(config) { this.config = config; this.pending = new Map(); this.ready = false; }
  start() {
    return new Promise((resolve, reject) => {
      this.startup = { resolve, reject };
      this.child = spawn(this.config.python, ['-B', '-u', fileURLToPath(new URL('../worker/speech_gate.py', import.meta.url)), this.config.model],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, PYTHONPATH: this.config.dependencies, PYTHONIOENCODING: 'utf-8' } });
      this.timer = setTimeout(() => this.fail(new Error('Speech detector startup timeout')), 30000);
      this.child.on('error', error => this.fail(error));
      this.child.on('exit', () => this.fail(new Error('Speech detector exited')));
      this.child.stdin.on('error', error => this.fail(error));
      createInterface({ input: this.child.stdout }).on('line', line => {
        try {
          const value = JSON.parse(line);
          if (value.ready === true) { clearTimeout(this.timer); this.ready = true; resolve(); return; }
          const pending = this.pending.get(value.id);
          if (!pending || !Number.isFinite(value.peak) || value.peak < 0 || value.peak > 1) throw new Error('Invalid speech detector reply');
          clearTimeout(pending.timer); this.pending.delete(value.id);
          pending.resolve({ state: value.noise_floor === true && value.peak < 0.15 ? 'silence' : value.peak >= 0.5 ? 'speech' : 'unknown',
            method: 'silero-vad', max_probability: value.peak });
        } catch (error) { if (!(error instanceof Error)) throw error; this.fail(error); }
      });
    });
  }
  fail(error) {
    clearTimeout(this.timer); this.ready = false; this.startup?.reject(error);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.child?.kill();
  }
  async process(job) {
    if (!this.ready) return { state: 'unknown', method: 'silero-unavailable' };
    try {
      return await new Promise((resolve, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => this.fail(new Error('Speech detector inference timeout')), 10000);
        this.pending.set(id, { resolve, reject, timer });
        this.child.stdin.write(JSON.stringify({ id, pcm: job.pcm.toString('base64') }) + '\n');
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      console.error(JSON.stringify({ event: 'speech_detector.unavailable', error: error.message }));
      return { state: 'unknown', method: 'silero-unavailable' };
    }
  }
  async stop() { this.fail(new Error('Speech detector stopped')); await stopProcessTree(this.child); }
}
