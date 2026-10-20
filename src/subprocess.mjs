import { spawn } from 'node:child_process';

const stopping = new WeakMap();
export function stopProcessTree(child) {
  if (!child?.pid) return Promise.resolve();
  if (stopping.has(child)) return stopping.get(child);
  const task = (async () => {
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32') {
        await new Promise(resolve => {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
            { shell: false, windowsHide: true, stdio: 'ignore' });
          let done = false;
          const finish = () => { if (done) return; done = true; clearTimeout(timer); child.kill(); resolve(); };
          const timer = setTimeout(() => { killer.kill(); finish(); }, 5000);
          killer.once('error', finish); killer.once('close', finish);
        });
      } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); }
      }
    }
    child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
  })();
  stopping.set(child, task); return task;
}
