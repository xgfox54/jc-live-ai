import { Writable } from 'node:stream';
import { openSync, writeSync, closeSync, fstatSync, renameSync, rmSync } from 'node:fs';

// Append-only log capped by size. At the cap the file is closed and renamed to <path>.1 (previous .1 is replaced).
export function boundedLog(path, limit = 50 * 1024 * 1024) {
  let fd = openSync(path, 'a'); let size = fstatSync(fd).size;
  return new Writable({
    write(chunk, encoding, callback) {
      try {
        if (size + chunk.length > limit && size > 0) {
          closeSync(fd); rmSync(path + '.1', { force: true });
          try { renameSync(path, path + '.1'); } catch { /* keep appending when rename is refused */ }
          fd = openSync(path, 'a'); size = fstatSync(fd).size;
        }
        writeSync(fd, chunk); size += chunk.length; callback();
      } catch (error) { callback(error); }
    },
    final(callback) { try { closeSync(fd); } catch { /* already closed */ } callback(); }
  });
}
