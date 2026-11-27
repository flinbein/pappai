import { closeSync, constants as F, fstatSync, openSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, normalize } from 'node:path';

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

// With a pinned base, paths are absolute within that directory.
export function openDirectory(path: string, base?: number): number {
  if (!isAbsolute(path) || normalize(path) !== path || path.includes('\0')) throw Error('Invalid directory');
  let parent = openSync(base === undefined ? '/' : fdPath(base), O_PATH | F.O_DIRECTORY);
  try {
    for (const part of path.split('/').filter(Boolean)) {
      const next = openSync(fdPath(parent) + '/' + part, O_PATH | F.O_DIRECTORY | F.O_NOFOLLOW);
      closeSync(parent);
      parent = next;
    }
    return parent;
  } catch (error) { closeSync(parent); throw error; }
}

// Pin a mount inode without opening special files for I/O. The caller checks
// its type with fstat and keeps this descriptor until the mount is finished.
export function openMountSource(path:string, base?:number):number {
  if (!isAbsolute(path) || normalize(path) !== path || path.includes('\0') || (path !== '/' && path.endsWith('/')))
    throw Error('Invalid mount source');
  if (path === '/') return openSync(base === undefined ? '/' : fdPath(base), O_PATH);
  const dir = openDirectory(dirname(path),base);
  try { return openSync(fdPath(dir) + '/' + basename(path), O_PATH | F.O_NOFOLLOW); }
  finally { closeSync(dir); }
}

export function enclosingMount(sources:ReadonlyMap<string,number>,path:string) {
  if (!isAbsolute(path)) throw Error('Invalid mount path');
  let name = path;
  while (name !== '/') {
    const fd = sources.get(name);
    if (fd !== undefined) return {name,fd};
    name = dirname(name);
  }
}

export function openMountedFile(path:string, mode:FileMode, canCreate:boolean, sources:ReadonlyMap<string,number>):number {
  if (!isAbsolute(path) || normalize(path) !== path || path.endsWith('/') || path.includes('\0')) throw Error('Invalid file path');
  const mount = enclosingMount(sources,path);
  if (!mount) throw Error('File access denied');
  const current = openMountSource(mount.name);
  try {
    const named = fstatSync(current,{bigint:true}), pinned = fstatSync(mount.fd,{bigint:true});
    if (named.dev !== pinned.dev || named.ino !== pinned.ino) throw Error('Terminal mount source changed');
    if (path !== mount.name) return openRegularFile(path.slice(mount.name.length),mode,canCreate,mount.fd);
    if (!pinned.isFile()) throw Error('Expected an ordinary file');
    if (mode === 'create') throw Object.assign(Error('File already exists'),{code:'EEXIST'});
    return openSync(fdPath(mount.fd), mode === 'read' ? F.O_RDONLY : F.O_WRONLY);
  } finally { closeSync(current); }
}

export function openRegularFile(path: string, mode: FileMode, canCreate = false, base?:number): number {
  if (process.platform !== 'linux') throw Error('Delegated files require Linux');
  if (!isAbsolute(path) || normalize(path) !== path || path.endsWith('/') || path.includes('\0'))
    throw Error('Invalid file path');
  const parts = path.slice(1).split('/');
  const leaf = parts.pop()!;
  const parent = openDirectory('/' + parts.join('/'), base);
  try {
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
export function openReadFile(path: string, allows: (path: string) => boolean, mounts?:ReadonlyMap<string,number>): number {
  if (!isAbsolute(path) || normalize(path) !== path || path.includes('\0') || !allows(path))
    throw Error('File access denied');
  const actual = realpathSync.native(path);
  if (!allows(actual)) throw Error('File access denied');
  if (process.platform === 'linux') {
    const fd = openRegularFile(actual, 'read');
    if (!mounts) return fd;
    try {
      const visible = openMountedFile(actual,'read',false,mounts);
      try {
        const opened = fstatSync(fd,{bigint:true}), mounted = fstatSync(visible,{bigint:true});
        if (opened.dev !== mounted.dev || opened.ino !== mounted.ino) throw Error('File access denied');
      } finally { closeSync(visible); }
      return fd;
    } catch (error) { closeSync(fd); throw error; }
  }
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
