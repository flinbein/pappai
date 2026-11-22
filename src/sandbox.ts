import { lstatSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import type { Assignment } from './runner.ts';

const baseEnvironment = {PATH: '/usr/local/bin:/usr/bin:/bin', TMPDIR: '/tmp'};
let temporaryRoot: string;
function checkPath(path: string) {
  if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path ||
      realpathSync(path) !== path) throw new Error('expected an existing absolute path without symlinks: ' + path);
  const stat = lstatSync(path);
  if (!stat.isDirectory() && !stat.isFile()) throw new Error('unsupported mount type: ' + path);
}

// Build the complete mount list before spawning. Neither validation failure nor a
// bubblewrap setup error may fall back to a launch on the host.
export function sandboxArgs(job: Pick<Assignment, 'appId' | 'sandbox' | 'settings'>): string[] {
  const {sandbox, settings} = job;
  if (process.platform !== 'linux' || !sandbox || typeof sandbox.network !== 'boolean' ||
      !Array.isArray(sandbox.read) || !Array.isArray(sandbox.write)) throw new Error('unsupported sandbox profile');
  if (!/^[a-zA-Z0-9_-]+$/.test(job.appId)) throw new Error('invalid APP id');
  checkPath(settings.cwd);
  if (!lstatSync(settings.cwd).isDirectory()) throw new Error('working directory must be a directory');
  const mounts = new Map<string, string>();
  for (const path of ['/bin', '/sbin', '/lib', '/usr', '/etc']) mounts.set(path, '--ro-bind');
  for (const [paths, mode] of [[sandbox.read, '--ro-bind'], [sandbox.write, '--bind']] as const) {
    for (const path of paths) {
      checkPath(path);
      if (path === '/' || ['/proc','/dev','/sys','/tmp','/run'].some(dir =>
        path === dir || path.startsWith(dir + '/'))) throw new Error('unsupported reserved mount: ' + path);
      mounts.set(path, mode);
    }
  }
  temporaryRoot ??= process.env.PAPPAI_TEMP_ROOT || mkdtempSync(join(tmpdir(), 'pappai-apps-'));
  const privateTmp = join(temporaryRoot, job.appId);
  mkdirSync(privateTmp, {recursive: true, mode: 0o700});
  const args = ['--unshare-all', '--unshare-user', '--cap-drop', 'ALL', '--die-with-parent',
    '--new-session', '--as-pid-1', '--json-status-fd', '4'];
  if (sandbox.network) args.push('--share-net');
  // A cwd does not confer a filesystem grant. Create its visible location in
  // the synthetic root before applying the actual mounts.
  if (settings.cwd !== '/') args.push('--dir', settings.cwd);
  // The mount list is ordered so that a more specific grant takes effect last.
  for (const [path, mode] of [...mounts].sort(([a], [b]) => a.length - b.length)) {
    args.push(mode, path, path);
  }
  args.push('--dev', '/dev', '--proc', '/proc', '--bind', privateTmp, '/tmp', '--remount-ro', '/',
    '--chdir', settings.cwd, '--clearenv');
  for (const [key, value] of Object.entries({...baseEnvironment, ...settings.env})) {
    if (!key || key.includes('=') || key.includes('\0') || typeof value !== 'string' ||
        value.includes('\0')) throw new Error('invalid environment entry');
    args.push('--setenv', key, value);
  }
  return args;
}
