import { cpus, freemem, totalmem } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const totals = () => cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle,
  total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 });
export class ResourceSampler {
  constructor() { this.previous = totals(); this.index = 0; }
  async sample(pids) {
    const now = totals(); const duration = now.total - this.previous.total;
    const cpu_percent = duration ? (1 - (now.idle - this.previous.idle) / duration) * 100 : 0;
    this.previous = now;
    const sample = { at: Date.now(), cpu_percent, host_used_memory_mb: (totalmem() - freemem()) / 1048576,
      node_rss_mb: process.memoryUsage().rss / 1048576 };
    if (this.index++ % 10 === 0) {
      const [gpu, processes] = await Promise.allSettled([
        run('nvidia-smi', ['--query-gpu=memory.used,utilization.gpu', '--format=csv,noheader,nounits'],
          { windowsHide: true, timeout: 5000 }),
        run('powershell.exe', ['-NoProfile', '-Command', '(Get-Process -Id ' + pids.filter(Number.isSafeInteger).join(',')
          + ' -ErrorAction SilentlyContinue) | Select-Object Id,CPU,WorkingSet64 | ConvertTo-Json -Compress'],
        { windowsHide: true, timeout: 5000 })]);
      if (gpu.status === 'fulfilled') {
        const [memory, percent] = gpu.value.stdout.trim().split(',').map(Number);
        sample.gpu_memory_mb = memory; sample.gpu_percent = percent;
      } else sample.gpu_query_error = true;
      if (processes.status === 'fulfilled') {
        const parsed = JSON.parse(processes.value.stdout || '[]'); sample.processes = Array.isArray(parsed) ? parsed : [parsed];
        sample.worker_memory_mb = sample.processes.reduce((sum, item) => sum + item.WorkingSet64, 0) / 1048576;
      } else sample.process_query_error = true;
    }
    return sample;
  }
}

export function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
}
