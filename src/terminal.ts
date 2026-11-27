import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';
import { basename, join, posix } from 'node:path';
import type { Readable } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { PermissionContext, Store } from './store.ts';
import { sandboxPrivateTmp, terminalSandboxArgs } from './sandbox.ts';
import { isWebRpcSocket } from './events.ts';
import { adminBroker, controlFrame, terminalBroker, type BrokerRequest } from './terminal-broker.ts';
import { openDirectory, openRegularFile } from './file-view.ts';
import type { FileView } from './file-delegations.ts';
import { fileLevel } from './permits.ts';

const bridge = readFileSync(new URL('./terminal-pty.py', import.meta.url), 'utf8');
const limit = 1024 * 1024;
type SessionUser = (req: IncomingMessage, touch?: boolean, expectedBrowserSession?: string) => string | null;
const validDimension = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 1000;
export type TerminalView = FileView;
type CliAction = {files: string[]; argv: string[]; env?: Record<string,string>; node?:string; calls?:string[]};
export type TerminalHooks = {
  prepareCli(actor: string, node: string, method: string, input: any, signal: AbortSignal): Promise<CliAction>;
  rpc(actor: string, method: string, params: any, view: TerminalView, signal: AbortSignal, ctx?:PermissionContext): Promise<any>;
};
type Command = {command?: string; argv?: string[]; env?: Record<string,string>};
type Run = {argv:string[]; cwd:string; withRpc:boolean; tty:boolean; env?:Record<string,string>};
type TerminalProcess = {child: ChildProcess; sandboxed: boolean};
type TerminalContext = {
  store: Store; actor: string; hooks?: TerminalHooks; authorized: () => boolean;
  signal: AbortSignal; forceSandbox: boolean; children: Set<Promise<void>>;
  depth: number; budget: {preparing: number};
  permissions?: PermissionContext; mounted?: TerminalView; scope?: Pick<CliAction,'node'|'calls'>;
};

function checkCommand(command: Command) {
  if (command.command !== undefined) {
    if (typeof command.command !== 'string' || !command.command.trim() || command.command.includes('\0') ||
        command.argv !== undefined) throw Error('Enter a terminal command');
  } else if (!Array.isArray(command.argv) || !command.argv.length || !command.argv[0] ||
      command.argv.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw Error('Invalid terminal argv');
  if (command.env !== undefined && (!command.env || typeof command.env !== 'object' || Array.isArray(command.env) ||
      Object.entries(command.env).some(([k,v]) => !k || /[=\0]/.test(k) || k.startsWith('PAPPAI_') ||
        typeof v !== 'string' || v.includes('\0')))) throw Error('Invalid terminal environment');
}

async function prepare(context: TerminalContext, cli: any) {
  if (!context.hooks || !cli || typeof cli.node !== 'string' || !cli.node || typeof cli.method !== 'string' || !cli.method ||
      Object.keys(cli).some(key => !['node', 'method', 'input'].includes(key)))
    throw Error('Invalid terminal CLI action');
  if (context.depth > 4 || context.budget.preparing + context.children.size >= 16)
    throw Error('Too many terminal CLI actions');
  context.budget.preparing++;
  try {
    const input = cli.input === undefined ? {} : cli.input;
    function check() {
      if (context.permissions && !context.store.contextAllows(context.actor,context.permissions,cli.node,'cli',cli.method,input))
        throw Error('Permission denied');
    }
    check();
    const descriptor = await context.hooks.prepareCli(context.actor, cli.node, cli.method, input, context.signal);
    check();
    return descriptor;
  } finally { context.budget.preparing--; }
}

function runOptions(params: any): Run {
  if (!params || typeof params !== 'object' || typeof params.tty !== 'boolean' || typeof params.withRpc !== 'boolean' ||
      typeof params.cwd !== 'string' || !posix.isAbsolute(params.cwd) || params.cwd.includes('\0') ||
      posix.normalize(params.cwd) !== params.cwd || (params.cwd !== '/' && params.cwd.endsWith('/')) ||
      Buffer.byteLength(params.cwd) > 4096 ||
      Object.keys(params).some(key => !['argv','env','tty','withRpc','cwd'].includes(key)))
    throw Error('Invalid run arguments');
  checkCommand({argv:params.argv, env:params.env});
  if (Object.keys(params.env ?? {}).some(key => !['TERM','LANG','LC_ALL','LC_CTYPE','COLORTERM'].includes(key)))
    throw Error('Invalid run environment');
  return params;
}

async function relayNested(context: TerminalContext, request: BrokerRequest, socket: Socket) {
  if (!validDimension(request.cols) || !validDimension(request.rows)) throw Error('Invalid terminal dimensions');
  if (context.depth > 4 || context.budget.preparing + context.children.size >= 16) throw Error('Too many terminal processes');
  // The client waits for the child's startup frame before forwarding terminal input.
  const earlyInput = () => socket.destroy();
  socket.on('data', earlyInput);
  const run = request.method === 'run' ? runOptions(request.params) : undefined;
  const descriptor = run ? undefined : await prepare(context, request.params);
  socket.removeListener('data', earlyInput);
  socket.pause();
  context.signal.throwIfAborted();
  const command = run ?? descriptor!;
  const {child} = launch(context, {argv: command.argv, env: command.env}, request.cols!, request.rows!, descriptor,run);
  socket.pipe(child.stdin!);
  child.stdout!.pipe(socket, {end: false});
  let diagnostic = '';
  child.stderr!.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-2048); });
  child.on('error', error => { diagnostic = error.message; });
  child.once('close', code => {
    if (socket.destroyed) return;
    if (code !== 0 && diagnostic) socket.end(controlFrame({error: diagnostic.trim()}));
    else socket.end();
  });
}

async function dispatch(context: TerminalContext, request: BrokerRequest, socket: Socket, mounted: TerminalView) {
  const {actor,store,scope,signal} = context;
  if (scope && !['me','run'].includes(request.method) && !(request.method === 'call' && request.params?.node === scope.node &&
      scope.calls?.includes(request.params?.method))) throw Error('Operation outside the CLI launch permissions');
  const permissions = store.restrict(actor,context.permissions,request.restrictPermissions,request.permissions);
  if (request.method === 'cli' || request.method === 'run') {
    await relayNested({...context, permissions},request,socket);
    return;
  }
  const view = permissions ? {...mounted, get revoked() { return mounted.revoked; },
    allows:(path:string,write = false) => mounted.allows(path,write) && store.fileSnapshot(actor,permissions).allows(path,write)} : mounted;
  const result = await context.hooks!.rpc(actor, request.method, request.params ?? {}, view, signal, permissions);
  if (!signal.aborted && context.authorized()) socket.end(controlFrame({result: result ?? null}));
  else socket.destroy();
}

// Pin only the working subtree. Its parent may rename entries while a new
// namespace is being built. Neither mount nor RPC follows user-owned links.
function pinWorkingDirectory(actor:string, path:string, parent:TerminalView): number | undefined {
  const within = (root:string) => path === root || path.startsWith(root + '/');
  try {
    if (parent.sharedCwd && within(parent.sharedCwd.path))
      return openDirectory(path.slice(parent.sharedCwd.path.length) || '/',parent.sharedCwd.fd);
    if (parent.scratch && within(parent.scratch.path))
      return openDirectory(join(parent.scratch.source,path.slice(parent.scratch.path.length)));
    return openDirectory(join(parent.privateTmp ?? sandboxPrivateTmp(actor),path.slice('/tmp/'.length)));
  } catch (error) {
    if (['ENOENT','ENOTDIR','EACCES','ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
    throw error;
  }
}

function launch(context: TerminalContext, command: Command, cols: number, rows: number, action?: CliAction, run?:Run): TerminalProcess {
  const {store, actor, hooks, signal, authorized, forceSandbox} = context;
  if (process.platform !== 'linux') throw Error('The web terminal requires a pappai Linux container');
  signal.throwIfAborted();
  if (!authorized()) throw Error('Terminal session expired');
  if (context.children.size >= 16) throw Error('Too many terminal processes');
  const view: TerminalView = store.fileSnapshot(actor,context.permissions,context.mounted?.sandbox ?? undefined);
  if (!view.sandbox && (forceSandbox || action || run)) {
    view.sandbox = {read: [], write: [], network: !!(action || run) && !forceSandbox};
    view.allows = (path, write = false) => path === '/tmp' || path.startsWith('/tmp/') ||
      fileLevel([], path) >= (write ? 2 : 1);
  }
  const sandbox = view.sandbox;
  const cwd = sandbox ? '/tmp' : '/root';
  const env = {TERM: 'xterm-256color', HOME: cwd, LANG: 'C.UTF-8', PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'};
  const settings = {cwd, command: '/usr/bin/python3', env};
  const args = ['-I', '-c', bridge];
  const fds: number[] = [];
  const setupFds:number[] = [];
  const life = new AbortController();
  const active = AbortSignal.any([signal, life.signal]);
  let broker: ReturnType<typeof terminalBroker> | undefined;
  let scratchMountpoint: string | undefined;
  let ownedTmp: string | undefined;
  function cleanup() {
    view.revoked = true;
    life.abort();
    broker?.close();
    if (view.scratch) {
      try { rmSync(view.scratch.source, {recursive: true, force: true, maxRetries: 3}); }
      catch (error) { console.error('Could not remove terminal scratch directory:', (error as NodeJS.ErrnoException).code); }
    }
    if (scratchMountpoint) { try { rmdirSync(scratchMountpoint); } catch {} }
    if (view.sharedCwd) closeSync(view.sharedCwd.fd);
    if (view.mountSources) for (const fd of view.mountSources.values()) closeSync(fd);
    if (ownedTmp) {
      try { rmSync(ownedTmp,{recursive:true,force:true,maxRetries:3}); }
      catch (error) { console.error('Could not remove run temporary directory:', (error as NodeJS.ErrnoException).code); }
    }
  }
  try {
    if (sandbox && hooks && (run ? run.withRpc : !action || action.calls?.length))
      broker = terminalBroker(() => !active.aborted && authorized(), (request, socket, connectionSignal) =>
        dispatch({...context, signal: AbortSignal.any([active,connectionSignal]), depth: context.depth + 1,
          scope: action ?? context.scope, mounted:view},request,socket,view));
    if (run) {
      view.privateTmp = ownedTmp = mkdtempSync('/run/pappai-run-');
      if (context.mounted?.sandbox && run.cwd.startsWith('/tmp/')) {
        const fd = pinWorkingDirectory(actor,run.cwd,context.mounted);
        if (fd !== undefined) view.sharedCwd = {path:run.cwd,fd};
      }
    } else if (context.mounted?.privateTmp) view.privateTmp = context.mounted.privateTmp;
    if (action) {
      if (!sandbox || !Array.isArray(action.files) || action.files.length > 64) throw Error('Invalid terminal CLI files');
      for (const file of action.files) fds.push(openRegularFile(file, 'read'));
      const source = mkdtempSync('/run/pappai-cli-');
      view.scratch = {source, path: '/tmp/' + basename(source)};
      const mountpoint = join(view.privateTmp ?? sandboxPrivateTmp(actor), basename(source));
      // Never mount over a pre-existing name in the USER-writable directory.
      mkdirSync(mountpoint, {mode: 0o700});
      scratchMountpoint = mountpoint;
    }
    checkCommand(command);
    const childFds = [...fds,...(view.sharedCwd ? [view.sharedCwd.fd] : [])];
    const verifyMounts: {path:string; mode:string; inode?:string; dev?:string}[] = [];
    const options = sandbox && terminalSandboxArgs({appId: actor, sandbox, settings}, {
      socket: broker?.path, files: fds.length, scratch: view.scratch,
      privateTmp:view.privateTmp,sharedCwd:view.sharedCwd?.path,
      sources:view.mountSources = new Map(),parentSources:context.mounted?.mountSources,setupFds,verifyMounts,
      parentAllowsWrite:context.mounted && (path => context.mounted!.allows(path,true)),
      passFd:fd => 4 + childFds.push(fd)});
    const childEnv = {...command.env,
      ...(view.scratch && {PAPPAI_CLI_TMP: view.scratch.path})};
    const data = Buffer.from(JSON.stringify({...command, env: childEnv, ...(verifyMounts.length && {verifyMounts}),
      ...(run && {tty:run.tty,cwd:view.allows(run.cwd) ? run.cwd : '/tmp'})}));
    if (data.length > 65536) throw Error('Terminal command is too long');
    const header = Buffer.alloc(8);
    header.writeUInt32BE(data.length);
    header.writeUInt16BE(rows, 4);
    header.writeUInt16BE(cols, 6);
    let child: ChildProcess;
    if (options) {
      child = spawn('/usr/bin/bwrap', [...options, '--', settings.command, ...args], {
        env: {PATH: env.PATH}, stdio: ['pipe', 'pipe', 'pipe', 'ignore', 'pipe', ...childFds],
      });
      (child.stdio[4] as Readable).resume();
    } else child = spawn(settings.command, args, {cwd, env, stdio: 'pipe'});
    function stop() {
      view.revoked = true;
      broker?.close();
      child.stdin!.end();
      child.stdout!.resume();
      if (child.exitCode === null && child.signalCode === null) child.kill(sandbox ? 'SIGKILL' : 'SIGTERM');
    }
    signal.addEventListener('abort', stop, {once: true});
    child.stdin!.on('error', () => {});
    child.stdin!.write(Buffer.concat([header, data]));
    const done = new Promise<void>(resolve => child.once('close', () => {
      signal.removeEventListener('abort', stop);
      cleanup();
      resolve();
    }));
    context.children.add(done);
    void done.then(() => context.children.delete(done));
    return {sandboxed: !!sandbox, child};
  } catch (error) { cleanup(); throw error; }
  finally { for (const fd of [...fds,...setupFds]) closeSync(fd); }
}

function rejectStart(ws: WebSocket, manual: boolean, error: string, code = 1011) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(manual ? {error, startFailed: true} : {error}));
  ws.close(code);
}

function relayTerminal(ws: WebSocket, {child, sandboxed}: ReturnType<typeof launch>,
  manual: boolean,
  authorized: (touch: boolean) => boolean,
) {
  const input = child.stdin!, output = child.stdout!;
  let diagnostic = '';
  child.stderr!.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-2048); });
  child.on('error', error => { diagnostic = error.message; });
  let started = false, completed = false;
  let unrendered = 0;
  let pending = Buffer.alloc(0);
  output.on('data', (chunk: Buffer) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 5) {
      const kind = pending[0], length = pending.readUInt32BE(1);
      if (length > limit || (kind !== 0 && kind !== 1)) return ws.terminate();
      if (pending.length < length + 5) break;
      const data = pending.subarray(5, length + 5);
      pending = pending.subarray(length + 5);
      if (kind === 1) {
        if (!started || completed || ws.bufferedAmount > limit) return ws.terminate();
        unrendered += length;
        if (unrendered >= 131072) output.pause();
        ws.send(data);
      } else {
        let info;
        try { info = JSON.parse(data.toString()); }
        catch { return ws.terminate(); }
        if (!started && info?.startFailed === true && typeof info.error === 'string') return rejectStart(ws, manual, info.error);
        if (!started && info?.started === true && typeof info.program === 'string') {
          started = true;
          ws.send(JSON.stringify(manual ? {started: true, program: info.program, sandboxed} : {sandboxed}));
        } else if (started && !completed && Number.isInteger(info?.exitCode)) {
          completed = true;
          if (manual) ws.send(JSON.stringify({exitCode: info.exitCode}));
        } else return ws.terminate();
      }
    }
  });
  ws.on('message', (raw, binary) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!authorized(binary) || input.writableLength > limit) return ws.terminate();
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    let data = bytes;
    if (!binary) {
      try {
        const {cols, rows, rendered} = JSON.parse(bytes.toString());
        if (rendered !== undefined) {
          if (!Number.isInteger(rendered) || rendered < 1 || rendered > unrendered) throw Error();
          unrendered -= rendered;
          if (unrendered < 65536) output.resume();
          return;
        }
        if (!validDimension(cols) || !validDimension(rows)) throw Error();
        data = Buffer.alloc(4);
        data.writeUInt16BE(rows, 0);
        data.writeUInt16BE(cols, 2);
      } catch { ws.close(1008, 'Invalid terminal control'); return; }
    }
    const header = Buffer.alloc(5);
    header[0] = binary ? 1 : 2;
    header.writeUInt32BE(data.length, 1);
    input.write(Buffer.concat([header, data]));
  });
  child.once('close', (code, signal) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!started && !signal && (diagnostic || code !== 0)) {
      return rejectStart(ws, manual, diagnostic.trim() || 'Could not start terminal');
    }
    ws.close(completed && !pending.length ? 1000 : 1011);
  });
}

export function attachTerminals(server: Server, address: URL, store: Store, user: SessionUser, hooks?: TerminalHooks) {
  const wss = new WebSocketServer({noServer: true, maxPayload: 65536, perMessageDeflate: false});
  const terminals = new Map<WebSocket, {valid(): boolean; done: Promise<void>}>();
  let closing = false;
  let admin: Awaited<ReturnType<typeof adminBroker>> | undefined;
  const localChildren = new Set<Promise<void>>();
  const localBudget = {preparing:0};
  const localLife = new AbortController();
  const executorEndpoints = new Map<string, () => void>();

  server.on('upgrade', (req, socket, head) => {
    if (isWebRpcSocket(req.url)) return;
    function reject(status: string) {
      socket.end('HTTP/1.1 ' + status + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    }
    const url = req.url ?? '';
    const path = url.split('?',1)[0];
    const params = new URLSearchParams(url.slice(path.length+1));
    if (closing || !['/api/ws/terminal','/ws/terminal'].includes(path)) return reject('404 Not Found');
    for (const [key,value] of params) {
      const valid = (key === 'sandbox' && value === '1') || (key === 'start' && value === 'manual') ||
        (key === 'browserSession' && /^[a-zA-Z0-9_-]+$/.test(value));
      if (!valid || params.getAll(key).length > 1) return reject('404 Not Found');
    }
    const manual = params.has('start');
    const forceSandbox = params.has('sandbox');
    if (req.headers.origin !== address.origin || req.headers.host !== address.host) return reject('403 Forbidden');
    const actor = user(req, true, params.get('browserSession') ?? undefined);
    if (!actor) return reject('401 Unauthorized');
    wss.handleUpgrade(req, socket, head, ws => {
      const valid = () => user(req, false) === actor;
      let finish!: () => void;
      const done = new Promise<void>(resolve => { finish = resolve; });
      terminals.set(ws, {valid, done});
      let alive = true;
      const heartbeat = setInterval(() => {
        if (!alive || !valid()) return ws.terminate();
        alive = false;
        ws.ping();
      }, 15000);
      heartbeat.unref();
      ws.on('error', () => ws.terminate());
      ws.on('pong', () => { alive = true; });
      const life = new AbortController();
      const children = new Set<Promise<void>>();
      const context = {store, actor, hooks, authorized: valid, signal: life.signal, forceSandbox, children,
        depth: 0, budget: {preparing: 0}};
      ws.once('close', () => {
        clearInterval(heartbeat);
        life.abort();
        Promise.all(children).then(() => { terminals.delete(ws); finish(); });
      });
      async function start(command: Command, cli?: any, cols = 80, rows = 24) {
        try {
          const action = cli === undefined ? undefined : await prepare(context, cli);
          const terminal = launch(context, action ? {argv: action.argv, env: action.env} : command, cols, rows, action);
          relayTerminal(ws, terminal, manual, touch => user(req, touch) === actor);
        } catch (error) { rejectStart(ws, manual, (error as Error).message); }
      }
      if (manual) {
        ws.once('message', (raw, binary) => {
          if (closing || user(req) !== actor) return ws.terminate();
          let request;
          try { if (!binary) request = JSON.parse(raw.toString()); } catch {}
          const {command, argv, env, cli, cols, rows} = request ?? {};
          try {
            if (cli === undefined) checkCommand({command, argv, env});
            else if (command !== undefined || argv !== undefined || env !== undefined) throw Error('Invalid CLI action launch');
          } catch (error) { return rejectStart(ws, manual, (error as Error).message, 1008); }
          if ((cols !== undefined || rows !== undefined) && (!validDimension(cols) || !validDimension(rows))) {
            return rejectStart(ws, manual, 'Invalid terminal dimensions', 1008);
          }
          void start({command, argv, env}, cli, cols, rows);
        });
      } else {
        void start({argv: ['/bin/sh', '-i']});
      }
    });
  });
  return {
    executorSocket(id:string, actor:string, mounted:TerminalView, current:() => boolean) {
      if (!hooks || closing || executorEndpoints.has(id)) throw Error('Cannot open executor RPC socket');
      const life = new AbortController();
      const children = new Set<Promise<void>>();
      const budget = {preparing:0};
      const authorized = () => !closing && !life.signal.aborted && !mounted.revoked && current();
      const broker = terminalBroker(authorized,(request,socket,connectionSignal) =>
        dispatch({store,actor,hooks,mounted,authorized,forceSandbox:false,children,budget,depth:1,
          signal:AbortSignal.any([life.signal,connectionSignal])},request,socket,mounted));
      executorEndpoints.set(id,() => {
        executorEndpoints.delete(id);
        life.abort();
        broker.close();
        for (const child of children) {
          localChildren.add(child);
          void child.then(() => localChildren.delete(child));
        }
      });
      return broker.path;
    },
    closeExecutor(id:string) { executorEndpoints.get(id)?.(); },
    async enableAdmin() {
      if (!hooks) throw Error('Administrator RPC requires terminal hooks');
      admin = await adminBroker(async (request,socket,connectionSignal) => {
        const actor = request.asNode ?? '~';
        const valid = () => {
          const node = store.get(actor);
          return !closing && node?.status === 'working' &&
            (actor === '~' || node.type === 'user' || node.type === 'app' || node.type === 'team');
        };
        if (!valid()) throw Error('Expected an active workspace, TEAM, USER or APP');
        const {node,method} = request.params ?? {};
        console.info('Local administrator RPC', JSON.stringify({administrator:'~',actor,operation:request.method,
          node:typeof node==='string' ? node.slice(0,256) : undefined,
          feature:typeof method==='string' ? method.slice(0,256) : undefined}));
        const signal = AbortSignal.any([localLife.signal,connectionSignal]);
        const view = store.fileSnapshot(actor);
        await dispatch({store,actor,hooks,authorized:valid,signal,forceSandbox:false,children:localChildren,
          depth:1,budget:localBudget},request,socket,view);
      });
    },
    checkSessions() {
      for (const [ws, terminal] of terminals) if (!terminal.valid()) ws.terminate();
    },
    async close() {
      closing = true;
      localLife.abort();
      admin?.close();
      for (const close of executorEndpoints.values()) close();
      const pending = Array.from(terminals.values(), terminal => terminal.done);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await Promise.all([...pending,...localChildren]);
    },
  };
}
