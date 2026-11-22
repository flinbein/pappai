import { randomUUID } from 'node:crypto';
import { closeSync, createReadStream, createWriteStream, fstatSync, ftruncateSync, mkdtempSync,
  rmdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { openRegularFile, type FileMode } from './file-view.ts';
import { sandboxPrivateTmp } from './sandbox.ts';
import type { Store } from './store.ts';

type FileGrants = Record<FileMode, string[]>;
type FileView = ReturnType<Store['fileSnapshot']>;
type Call = {
  actor: string; target: string; executor?: string; callerView?: FileView; grants: FileGrants;
  abort: AbortController; handles: Map<string, Handle>; copies: number;
};
type Handle = {fd?: number; mode: FileMode};
type Endpoint = {path: string; dir: string; server: Server; app?: string; view?: FileView};
const maxOperations = 32;

function filePath(value: unknown, scope = false): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0') ||
      posix.normalize(value) !== value || (!scope && value.endsWith('/')) ||
      Buffer.byteLength(value) > 4096) throw Error('Invalid absolute file path');
  return value;
}

function parseGrants(params: any): FileGrants {
  const grants: FileGrants = {read: [], write: [], create: []};
  for (const mode of ['read', 'write', 'create'] as const) {
    if (params[mode] === undefined) continue;
    if (!Array.isArray(params[mode]) || params[mode].length > 128) throw Error('Invalid file grants');
    grants[mode] = params[mode].map((entry: unknown) => filePath(entry, true));
  }
  return grants;
}

function covers(grants: string[], path: string) {
  return grants.some(grant => grant.endsWith('/') ? path.startsWith(grant) : path === grant);
}

function effectiveMode(call: Call, path: string, mode: FileMode): FileMode {
  if (covers(call.grants[mode], path) || (mode === 'create' && covers(call.grants.write, path))) return mode;
  throw Error('File access denied');
}

function copyPath(value: any): {side: 'caller' | 'self'; path: string} {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 1)
    throw Error('Expected self or caller file path');
  const side = Object.keys(value)[0];
  if (side !== 'self' && side !== 'caller') throw Error('Expected self or caller file path');
  return {side, path: filePath(value[side])};
}

export class FileDelegations {
  private store: Pick<Store, 'fileSnapshot'>;
  private calls = new Map<string, Call>();
  private endpoints = new Map<string, Endpoint>();
  private handles = new Map<string, Call>();

  constructor(store: Pick<Store, 'fileSnapshot'>) { this.store = store; }

  callOpened(id: string, actor: string, target: string, params: any, callerExecutor?: string) {
    const grants = parseGrants(params);
    if (Object.values(grants).some(paths => paths.length)) {
      if (process.platform !== 'linux') throw Error('Delegated files require Linux');
      const endpoint = callerExecutor ? this.endpoints.get(callerExecutor) : undefined;
      if (callerExecutor && (!endpoint?.view || endpoint.app !== actor)) throw Error('Unknown caller file view');
      this.calls.set(id, {actor, target, grants, callerView:endpoint?.view,
        abort: new AbortController(), copies: 0, handles: new Map()});
    }
  }

  callAssigned(id: string, executor: string) {
    const call = this.calls.get(id);
    if (call) call.executor = executor;
  }

  unfinished(id: string) {
    const call = this.calls.get(id);
    return !!call && (call.copies > 0 || [...call.handles.values()].some(h => h.mode !== 'read'));
  }

  callClosed(id: string) {
    const call = this.calls.get(id);
    if (!call) return;
    this.calls.delete(id);
    call.abort.abort();
    for (const [key, handle] of call.handles) {
      this.handles.delete(key);
      if (handle.fd !== undefined) closeSync(handle.fd);
    }
    call.handles.clear();
  }

  // listen(path) binds a Unix socket before returning. Each mount belongs to
  // a single executor generation; it cannot authenticate with another mount.
  socketFor(executor: string, app?: string): string | undefined {
    if (process.platform !== 'linux') return;
    const existing = this.endpoints.get(executor);
    if (existing) return existing.path;
    const view = app === undefined ? undefined : this.store.fileSnapshot(app);
    const dir = mkdtempSync(join(tmpdir(), 'pappai-files-'));
    const path = join(dir, 'socket');
    const server = createServer({maxHeaderSize: 4096}, (req, res) => {
      void this.transfer(executor, req, res).catch(() => res.destroy());
    });
    server.maxConnections = 64;
    server.headersTimeout = 15_000;
    server.requestTimeout = 0;
    server.maxRequestsPerSocket = 1;
    server.on('error', () => this.executorExit(executor));
    server.listen(path);
    this.endpoints.set(executor, {dir, path, server, app, view});
    return path;
  }

  executorExit(executor: string, _appId?: string) {
    for (const [id, call] of this.calls) if (call.executor === executor) this.callClosed(id);
    const endpoint = this.endpoints.get(executor);
    if (!endpoint) return;
    this.endpoints.delete(executor);
    endpoint.server.close(() => {
      try { rmdirSync(endpoint.dir); } catch { /* externally removed or still busy */ }
    });
    endpoint.server.closeAllConnections();
  }

  private open(actor: string, path: string, mode: FileMode, mounted?: FileView) {
    const current = this.store.fileSnapshot(actor);
    const allows = (name: string, write: boolean) => current.allows(name, write) &&
      (!mounted || mounted.allows(name, write));
    if (['/proc', '/sys', '/dev', '/run'].some(dir => path === dir || path.startsWith(dir + '/')) ||
        !allows(path, mode !== 'read')) throw Error('File access denied');
    // Mounts outlive a permissions change. A new sandbox's private /tmp
    // cannot authorize opening the host /tmp of an older trusted process.
    if (path.startsWith('/tmp/') && mounted?.sandbox === null && current.sandbox !== null)
      throw Error('File access denied');
    const actual = path.startsWith('/tmp/') && (mounted ?? current).sandbox !== null
      ? join(sandboxPrivateTmp(actor), path.slice('/tmp/'.length)) : path;
    // Host paths, especially private tmp backing directories, stay off the wire.
    const canCreate = mode !== 'read' && allows(posix.dirname(path), true);
    if (mode === 'create' && !canCreate) throw Error('File creation denied');
    try { return openRegularFile(actual, mode, canCreate); }
    catch (err) { throw Error((err as NodeJS.ErrnoException).code ?? 'Expected an ordinary file'); }
  }

  async executorRequest(executor: string, app: string, method: string, params: any) {
    const call = this.calls.get(params?.callId);
    if (!call || call.executor !== executor || call.target !== app) throw Error('File access denied');
    if (call.handles.size + call.copies >= maxOperations) throw Error('Too many open file operations');
    if (method === 'files.open') {
      const path = filePath(params.path);
      const mode = params.mode;
      if (mode !== 'read' && mode !== 'write' && mode !== 'create') throw Error('Invalid file mode');
      const fd = this.open(call.actor, path, effectiveMode(call, path, mode),call.callerView);
      const handle = randomUUID();
      call.handles.set(handle, {fd, mode});
      this.handles.set(handle, call);
      return {handle};
    }
    if (method !== 'files.copy') throw Error('Unknown file request');
    const from = copyPath(params.from);
    const to = copyPath(params.to);
    if (from.side === to.side) throw Error('Expected a copy between self and caller');
    const srcMode = from.side === 'caller' ? effectiveMode(call, from.path, 'read') : 'read';
    const dstMode = to.side === 'self' || covers(call.grants.write, to.path)
      ? 'write' : effectiveMode(call, to.path, 'create');
    let src: number | undefined;
    let dst: number | undefined;
    call.copies++;
    try {
      const selfView = this.endpoints.get(executor)?.view;
      src = from.side === 'caller' ? this.open(call.actor,from.path,srcMode,call.callerView) :
        this.open(app,from.path,srcMode,selfView);
      dst = to.side === 'caller' ? this.open(call.actor,to.path,dstMode,call.callerView) :
        this.open(app,to.path,dstMode,selfView);
      const source = fstatSync(src, {bigint:true});
      const destination = fstatSync(dst, {bigint:true});
      if (source.dev === destination.dev && source.ino === destination.ino) throw Error('Same source and destination');
      ftruncateSync(dst, 0);
      const input = createReadStream('', {fd:src});
      src = undefined;
      const output = createWriteStream('', {fd:dst});
      dst = undefined;
      await pipeline(input, output, {signal:call.abort.signal});
      return {bytesCopied:output.bytesWritten};
    } finally {
      if (src !== undefined) closeSync(src);
      if (dst !== undefined) closeSync(dst);
      call.copies--;
    }
  }

  private async transfer(executor: string, req: IncomingMessage, res: ServerResponse) {
    const key = req.url?.slice(1) ?? '';
    const call = this.handles.get(key);
    const handle = call?.handles.get(key);
    if (!call || call.executor !== executor || !handle || handle.fd === undefined ||
        req.method !== (handle.mode === 'read' ? 'GET' : 'PUT')) {
      res.writeHead(403, {Connection:'close'}).end();
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    const fd = handle.fd;
    handle.fd = undefined;
    if (handle.mode === 'read') {
      res.setHeader('Content-Type', 'application/octet-stream');
      try { await pipeline(createReadStream('', {fd}), res, {signal:call.abort.signal}); }
      finally { call.handles.delete(key); this.handles.delete(key); }
    } else {
      // HTTP final chunk or a complete Content-Length is the explicit end.
      // pipeline destroys the writable and closes its descriptor on abort.
      const output = createWriteStream('', {fd});
      await pipeline(req, output, {signal:call.abort.signal});
      if (!req.complete || call.abort.signal.aborted) throw Error('Incomplete file transfer');
      call.handles.delete(key);
      this.handles.delete(key);
      res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify({bytesWritten:output.bytesWritten}));
    }
  }
}
