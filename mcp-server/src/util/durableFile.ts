import { closeSync, fsyncSync, openSync, renameSync, writeSync } from 'node:fs';
import path from 'node:path';

// A rename alone survives a process crash but not a power cut: without fsync the new file's
// blocks may never reach disk and the rename can land on an empty file. Run state and the
// knowledge store are rewritten whole, so a torn write loses the run, not one record.

function fsyncDirectory(dir: string): void {
  try {
    const fd = openSync(dir, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Some filesystems refuse to fsync a directory; the file itself is already durable.
  }
}

/** Replace `destination` with `content` so a reader sees either the old file or the new one. */
export function writeFileAtomic(destination: string, content: string): void {
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(temporary, 'w');
  try {
    writeSync(fd, content, null, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, destination);
  fsyncDirectory(path.dirname(destination));
}

/** Append `content` and flush it to disk before returning. */
export function appendFileDurable(file: string, content: string): void {
  const fd = openSync(file, 'a');
  try {
    writeSync(fd, content, null, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
