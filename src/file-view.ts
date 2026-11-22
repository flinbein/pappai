import { closeSync, constants as F, fstatSync, openSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';

export type FileMode = 'read' | 'write' | 'create';

// Linux O_PATH pins an inode without opening a FIFO, device or socket for I/O.
// Node does not expose this constant. Every user-controlled component is opened
// with O_NOFOLLOW; only our own kernel fd links may be followed.
const O_PATH = 0x200000;
const fdPath = (fd: number) => '/proc/self/fd/' + fd;

function openExisting(path: string, mode: FileMode): number {
  const object = openSync(path, O_PATH | F.O_NOFOLLOW);
  try {
    if (!fstatSync(object).isFile()) throw Error('Expected an ordinary file');
    return openSync(fdPath(object), mode === 'read' ? F.O_RDONLY : F.O_WRONLY);
  } finally { closeSync(object); }
}

export function openRegularFile(path: string, mode: FileMode, canCreate = false): number {
  if (process.platform !== 'linux') throw Error('Delegated files require Linux');
  if (!isAbsolute(path) || normalize(path) !== path || path.endsWith('/') || path.includes('\0'))
    throw Error('Invalid file path');
  const parts = path.slice(1).split('/');
  const leaf = parts.pop()!;
  let parent = openSync('/', O_PATH | F.O_DIRECTORY);
  try {
    for (const part of parts) {
      const next = openSync(fdPath(parent) + '/' + part, O_PATH | F.O_DIRECTORY | F.O_NOFOLLOW);
      closeSync(parent);
      parent = next;
    }
    const name = fdPath(parent) + '/' + leaf;
    if (mode === 'create' && !canCreate) throw Error('File creation denied');
    if (canCreate && mode !== 'read') {
      try { return openSync(name, F.O_WRONLY | F.O_CREAT | F.O_EXCL | F.O_NOFOLLOW, 0o600); }
      catch (error) {
        if (mode === 'create' || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    return openExisting(name, mode);
  } finally { closeSync(parent); }
}

// Manifest files may be symlinks. Check both names before opening and on
// Linux walk the resolved name with the same pinned-directory rules as RPC.
export function openReadFile(path: string, allows: (path: string) => boolean): number {
  if (!isAbsolute(path) || normalize(path) !== path || path.includes('\0') || !allows(path))
    throw Error('File access denied');
  const actual = realpathSync.native(path);
  if (!allows(actual)) throw Error('File access denied');
  if (process.platform === 'linux') return openRegularFile(actual, 'read');
  // Native desktop development: verify that the opened object matches the
  // authorized resolved filename. Production isolation runs on Linux.
  const fd = openSync(actual, F.O_RDONLY | (F.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(fd, {bigint:true});
    const named = statSync(actual, {bigint:true});
    if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino ||
        realpathSync.native(actual) !== actual) throw Error('Expected an ordinary file');
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}
