import { lstatSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function assertRunnerName(name) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(name) || name === 'process') {
    throw Error('Invalid external runner name');
  }
}

// Inspect every component before walking into it, including the mounted private root.
export function runnerDirectory(path, create = false) {
  const current = resolve(path);
  const parent = dirname(current);
  if (current !== parent) runnerDirectory(parent, create);
  let stat = lstatSync(current, { throwIfNoEntry: false });
  if (!stat && create) {
    try { mkdirSync(current, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    stat = lstatSync(current);
  }
  if (!stat?.isDirectory()) throw Error('Expected runner directory: ' + current);
}

export async function withRunnerLock(root, name, operation) {
  assertRunnerName(name);
  const locks = join(root, '.locks');
  runnerDirectory(locks, true);
  const file = join(locks, name + '.sqlite');
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (stat && !stat.isFile()) throw Error('Invalid runner lock');
  const db = new DatabaseSync(file);
  try {
    // The OS releases SQLite locks if an installer terminates during a download.
    try { db.exec('BEGIN EXCLUSIVE'); }
    catch (error) {
      if (error.errcode === 5) throw Error('Runner operation in progress: ' + name);
      throw error;
    }
    return await operation();
  } finally {
    db.close();
  }
}
