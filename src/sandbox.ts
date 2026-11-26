import { lstatSync, mkdirSync, mkdtempSync, realpathSync, readdirSync, readlinkSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import type { Assignment, ProcessSettings } from './runner.ts';

const baseEnvironment = {PATH: '/usr/local/bin:/usr/bin:/bin', TMPDIR: '/tmp'};
export function initTempRoot() {
  return process.env.PAPPAI_TEMP_ROOT ||= mkdtempSync(join(tmpdir(), 'pappai-apps-'));
}
export function sandboxPrivateTmp(id:string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw Error('Invalid temporary directory owner');
  const root=initTempRoot();
  mkdirSync(root,{recursive:true,mode:0o700});
  const path=join(root,id);
  mkdirSync(path,{recursive:true,mode:0o700});
  checkPath(path);
  if (!lstatSync(path).isDirectory()) throw Error('Invalid private temporary directory');
  return path;
}
function checkPath(path: string) {
  if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path ||
      realpathSync(path) !== path) throw new Error('expected an existing absolute path without symlinks: ' + path);
  const stat = lstatSync(path);
  if (!stat.isDirectory() && !stat.isFile()) throw new Error('unsupported mount type: ' + path);
}

// Build the complete mount list before spawning. Neither validation failure nor a
// bubblewrap setup error may fall back to a launch on the host.
type SandboxJob = Pick<Assignment<ProcessSettings>, 'appId' | 'sandbox' | 'settings'|'runtimeMounts'>;
type TerminalMounts = {
  socket?: string;
  files: number;
  scratch?: {source: string; path: string};
};

export function sandboxArgs(job: SandboxJob): string[] {
  return buildSandboxArgs(job);
}

// Only the terminal launcher can supply these mounts and inherited file descriptors.
export function terminalSandboxArgs(job: Omit<SandboxJob, 'runtimeMounts'>, terminal: TerminalMounts): string[] {
  return buildSandboxArgs(job, terminal);
}

function buildSandboxArgs(job: SandboxJob, terminal?: TerminalMounts): string[] {
  const {sandbox, settings} = job;
  if (process.platform !== 'linux' || !sandbox || typeof sandbox.network !== 'boolean' ||
      !Array.isArray(sandbox.read) || !Array.isArray(sandbox.write)) throw new Error('unsupported sandbox profile');
  if (!/^[a-zA-Z0-9_-]+$/.test(job.appId)) throw new Error('invalid APP id');
  checkPath(settings.cwd);
  if (!lstatSync(settings.cwd).isDirectory()) throw new Error('working directory must be a directory');
  const mounts = new Map<string, string>();
  for (const path of ['/bin', '/sbin', '/lib', '/usr', '/etc']) mounts.set(path, '--ro-bind');
  const hidden = (sandbox as typeof sandbox & {hide?:string[]}).hide ?? [];
  const links = new Map<string,string>();
  const requested = new Map<string,string>();
  for (const [paths, mode] of [[sandbox.read, '--ro-bind'], [sandbox.write, '--bind'],[hidden,'hide']] as const) {
    for (const path of paths) {
      requested.set(path,mode);
    }
  }
  for (const [path, mode] of [...requested].sort(([a],[b])=>a.length-b.length)) {
      checkPath(path);
      if (path === '/') {
        if (mode !== 'hide') for (const item of readdirSync('/',{withFileTypes:true})) {
          if (['proc','dev','sys','tmp','run'].includes(item.name)) continue;
          const target='/'+item.name;
          if (item.isSymbolicLink()) links.set(target, readlinkSync(target));
          else if (item.isFile() || item.isDirectory()) mounts.set(target,mode);
        }
        continue;
      }
      if (['/proc','/dev','/sys','/tmp','/run'].some(dir =>
        path === dir || path.startsWith(dir + '/'))) throw new Error('unsupported reserved mount: ' + path);
      mounts.set(path, mode);
  }
  const privateTmp = sandboxPrivateTmp(job.appId);
  const args = ['--unshare-all', '--unshare-user', '--cap-drop', 'ALL', '--die-with-parent',
    '--new-session', '--as-pid-1', '--json-status-fd', '4'];
  if (sandbox.network) args.push('--share-net');
  // A cwd does not confer a filesystem grant. Create its visible location in
  // the synthetic root before applying the actual mounts.
  if (settings.cwd !== '/') args.push('--dir', settings.cwd);
  // The mount list is ordered so that a more specific grant takes effect last.
  for (const [path,target] of links) args.push('--symlink',target,path);
  const maskedDirs:string[]=[];
  for (const [path, mode] of [...mounts].sort(([a], [b]) => a.length - b.length)) {
    if (mode!=='hide') args.push(mode, path, path);
    else if (lstatSync(path).isDirectory()) { args.push('--tmpfs',path); maskedDirs.push(path); }
    else args.push('--ro-bind','/dev/null',path);
  }
  for (const dir of maskedDirs) args.push('--remount-ro',dir);
  for (const mount of job.runtimeMounts ?? []) {
    if (!['/run/pappai/http','/run/pappai/files'].includes(mount.target) ||
      !isAbsolute(mount.source) || realpathSync(mount.source)!==mount.source) throw Error('Invalid runtime mount');
    args.push(mount.readonly?'--ro-bind':'--bind',mount.source,mount.target);
  }
  args.push('--dev', '/dev', '--proc', '/proc', '--bind', privateTmp, '/tmp');
  if (terminal) {
    if (terminal.socket) args.push('--ro-bind', terminal.socket, '/run/pappai/terminal.sock');
    for (let i = 0; i < terminal.files; i++) args.push('--ro-bind-fd', String(5 + i), '/run/pappai/cli/' + i);
    if (terminal.scratch) args.push('--bind', terminal.scratch.source, terminal.scratch.path);
  }
  args.push('--remount-ro', '/',
    '--chdir', settings.cwd, '--clearenv');
  for (const [key, value] of Object.entries({...baseEnvironment, ...settings.env})) {
    if (!key || key.includes('=') || key.includes('\0') || typeof value !== 'string' ||
        value.includes('\0')) throw new Error('invalid environment entry');
    args.push('--setenv', key, value);
  }
  return args;
}
