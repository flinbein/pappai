import { closeSync, fstatSync, readSync } from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { openReadFile } from './file-view.ts';
import { prepare } from './manifest.ts';
import { sandboxPrivateTmp } from './sandbox.ts';
import type { NodeRecord, PermissionContext, Store } from './store.ts';
import { callerFileView, type FileView } from './file-delegations.ts';

type Source = {manifest: any} | {file: string; override?: any};
type CallerFileAccess = {allows:(name:string,actual:string)=>boolean; mounts?:ReadonlyMap<string,number>};
type Hooks = {
  hasRunner(type: string): boolean;
  validateSettings?(type: string, settings: unknown): void;
  isPersistentRunning(id: string): boolean;
  apply(id: string, manifest: any): void;
  changed(id: string): void;
  created?(id: string): void;
  failed(id: string, issue: string): void;
};

function object(value: any) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fields(value: any, names: string[]) {
  if (!object(value) || Object.keys(value).some(key => !names.includes(key)))
    throw Error('Unexpected manifest source or override field');
}
function environment(source: Source | undefined) {
  if (!source) return;
  return ('manifest' in source ? source.manifest : source.override)?.run?.settings?.env;
}
function savedSource(value: any, previous: Source | undefined): Source {
  fields(value, Object.hasOwn(value ?? {}, 'manifest') ? ['manifest'] : ['file','override']);
  const source = structuredClone(value);
  if (!('manifest' in source)) {
    if (typeof source.file !== 'string' || !isAbsolute(source.file) || source.file.includes('\0') ||
        source.file.split(/[\\/]/).includes('..')) throw Error('Expected an absolute manifest file');
    if ('override' in source) {
      fields(source.override, ['run','executors','subscriptions']);
      if ('run' in source.override) {
        fields(source.override.run, ['settings']);
        if ('settings' in source.override.run) fields(source.override.run.settings, ['cwd','env']);
      }
      if ('executors' in source.override)
        fields(source.override.executors, ['poolSize','maxLifetimeMs','idleTimeoutMs','maxRestarts']);
    }
  }
  const env = environment(source);
  if (env !== undefined) {
    if (!object(env)) throw Error('Invalid manifest environment');
    for (const [key,val] of Object.entries<any>(env)) {
      if (typeof val === 'string' || (!('manifest' in source) && val === null)) continue;
      fields(val, ['secret']);
      if (val.secret === true) {
        const old = environment(previous);
        if (!old || !Object.hasOwn(old,key) || typeof old[key]?.secret !== 'string')
          throw Error('Secret mask has no saved value');
        val.secret = old[key].secret;
      }
      if (typeof val.secret !== 'string') throw Error('Invalid manifest secret');
    }
  }
  return source;
}
export function mask<T extends Source>(source: T): T {
  const result = structuredClone(source);
  for (const value of Object.values<any>(environment(result) ?? {}))
    if (object(value) && Object.hasOwn(value, 'secret')) value.secret = true;
  return result;
}
function readJSON(path: string, allows: (path: string)=>boolean, mounts?:ReadonlyMap<string,number>) {
  const fd = openReadFile(path, allows,mounts);
  try {
    const size = fstatSync(fd).size;
    if (size > 1024 * 1024) throw Error('Manifest exceeds 1 MiB');
    const buffer = Buffer.alloc(size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
      if (!count) break;
      bytes += count;
    }
    if (bytes !== size) throw Error('Manifest changed during read');
    try { return JSON.parse(buffer.toString('utf8',0,bytes)); }
    catch { throw Error('Manifest contains invalid JSON'); }
  } finally { closeSync(fd); }
}

function load(source: Source, read: (file: string)=>any) {
  if ('manifest' in source) return source.manifest;
  const manifest = read(source.file);
  if (!object(manifest?.run?.settings) || !object(manifest.executors))
    throw Error('Invalid file manifest');
  const override = source.override ?? {};
  const settings = manifest.run.settings;
  const patch = override.run?.settings ?? {};
  if (Object.hasOwn(patch,'cwd')) settings.cwd = patch.cwd;
  if (manifest.run.type === 'process') {
    if (settings.cwd !== undefined && typeof settings.cwd !== 'string') throw Error('Invalid manifest cwd');
    settings.cwd = resolve(dirname(source.file), settings.cwd ?? '.');
  }
  if (Object.hasOwn(patch,'env')) {
    if (settings.env !== undefined && !object(settings.env)) throw Error('Invalid manifest environment');
    settings.env = Object.fromEntries(Object.entries({...settings.env, ...patch.env})
      .filter(([,value]) => value !== null));
  }
  Object.assign(manifest.executors,override.executors);
  if (Object.hasOwn(override,'subscriptions')) manifest.subscriptions = override.subscriptions;
  return manifest;
}

export class ManifestSources {
  private store: Store;
  private hooks: Hooks;
  private watches = new Map<string,{ids: Set<string>; timer: NodeJS.Timeout}>();
  private watched = new Map<string,string>();
  private pending = new Map<string,any>();
  constructor(store: Store, hooks: Hooks) {
    this.store = store;
    this.hooks = hooks;
    store.db.exec('CREATE TABLE IF NOT EXISTS manifest_sources(appId TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE, source TEXT NOT NULL, allowLinks INTEGER NOT NULL) STRICT');
  }
  private source(node: NodeRecord): Source {
    const row = this.store.db.prepare('SELECT source FROM manifest_sources WHERE appId=?').get(node.id);
    return row ? JSON.parse(String(row.source)) : {manifest:node.manifest};
  }
  private file(id: string, path: string) {
    if (this.store.sandbox(id) === null) return {path,logical:(name:string)=>name,
      allows:(name:string)=>this.store.allowsFile(id,name,false)};
    const temporary = path.startsWith('/tmp/') ? sandboxPrivateTmp(id) : undefined;
    const host = temporary ? join(temporary,path.slice(5)) : path;
    const logical=(name:string)=>temporary && name.startsWith(temporary + sep) ? '/tmp/' + name.slice(temporary.length + 1) : name;
    return {path:host,logical,allows:(name:string)=>{
      if (logical(name)!==name) return this.store.allowsFile(id,logical(name),false);
      if (name === '/tmp' || name.startsWith('/tmp/')) return false;
      return this.store.allowsFile(id,name,false);
    }};
  }
  private candidate(id: string, source: Source, allowLinks: boolean,caller?:CallerFileAccess) {
    const candidate = load(source, path => {
      try {
        const file = this.file(id,path);
        return readJSON(file.path, name=>(allowLinks || name === file.path) && file.allows(name) &&
          (!caller || caller.allows(file.logical(name),name)), path.startsWith('/tmp/') ? undefined : caller?.mounts);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') throw Error('Manifest file not found');
        if (code) throw Error('Manifest file unavailable');
        throw error;
      }
    });
    const config = prepare(candidate);
    if (!this.hooks.hasRunner(config.runnerType)) throw Error('Unknown runner type');
    this.hooks.validateSettings?.(config.runnerType,config.settings);
    return candidate;
  }
  private reconcile(node: NodeRecord, candidate: any, notify: boolean) {
    const changed = !isDeepStrictEqual(candidate, this.pending.get(node.id) ?? node.manifest);
    if (isDeepStrictEqual(candidate, node.manifest)) this.pending.delete(node.id);
    else if (this.hooks.isPersistentRunning(node.id)) this.pending.set(node.id,candidate);
    else {
      this.hooks.apply(node.id,candidate);
      this.pending.delete(node.id);
    }
    if (changed && notify) this.hooks.changed(node.id);
  }
  applyPending(id: string) {
    if (this.hooks.isPersistentRunning(id) || !(this.pending.has(id) || this.watched.has(id))) return;
    // Recheck file access and the current source before applying a deferred change.
    this.refresh(id);
  }
  manifestChanged(id: string) { return this.pending.has(id); }
  private refresh(id: string) {
    const node = this.store.get(id);
    if (!node) return this.watch(id);
    try { this.check(node); }
    catch (error) { this.hooks.failed(id,'Manifest: ' + (error as Error).message); }
  }
  private check(node: NodeRecord,caller?:CallerFileAccess) {
    const row = this.store.db.prepare('SELECT source,allowLinks FROM manifest_sources WHERE appId=?').get(node.id);
    if (!row) return;
    const source: Source = JSON.parse(String(row.source));
    this.watch(node.id,'file' in source ? this.file(node.id,source.file).path : undefined);
    this.reconcile(node,this.candidate(node.id,source,!!row.allowLinks,caller),true);
  }
  private watch(id: string, file?: string) {
    const old = this.watched.get(id);
    if (old === file) return;
    if (old) {
      const watch = this.watches.get(old)!;
      watch.ids.delete(id);
      if (!watch.ids.size) {
        clearInterval(watch.timer);
        this.watches.delete(old);
      }
      this.watched.delete(id);
    }
    if (!file) return;
    let watch = this.watches.get(file);
    if (!watch) {
      const ids = new Set<string>();
      let previous: string|undefined, busy = false;
      const poll = async () => {
        if (busy) return;
        busy = true;
        try {
          let signature;
          try {
            const [link, target, name] = await Promise.all([lstat(file,{bigint:true}),stat(file,{bigint:true}),realpath(file)]);
            signature = [link.dev,link.ino,link.ctimeNs,target.dev,target.ino,target.ctimeNs,target.mtimeNs,target.size,name].join(':');
          } catch (error) { signature = 'unavailable:' + (error as NodeJS.ErrnoException).code; }
          if (signature !== previous) {
            previous = signature;
            for (const app of ids) this.refresh(app);
          }
        } finally { busy = false; }
      };
      const timer = setInterval(poll,250);
      timer.unref();
      watch = {ids,timer};
      this.watches.set(file,watch);
    }
    watch.ids.add(id);
    this.watched.set(id,file);
  }
  restore() {
    for (const row of this.store.db.prepare('SELECT appId FROM manifest_sources').all()) this.refresh(String(row.appId));
  }
  close() {
    for (const watch of this.watches.values()) {
      clearInterval(watch.timer);
      watch.ids.clear();
    }
    this.watches.clear();
    this.watched.clear();
    this.pending.clear();
  }
  system(actor: string,node: NodeRecord,method: string,data: any,context?:PermissionContext,mounted?:FileView) {
    const caller:CallerFileAccess|undefined=context || mounted ? {mounts:mounted?.mountSources,allows:(name,actual)=>{
      const view=callerFileView(this.store,actor,mounted,context);
      if (!view.allows(name)) return false;
      // APP sources live in the APP filesystem. A caller's other mount at the
      // same name (a pinned task directory or private tmp) cannot authorize it.
      if (mounted?.sharedCwd && (name===mounted.sharedCwd.path || name.startsWith(mounted.sharedCwd.path+'/'))) return false;
      if (mounted?.scratch && name.startsWith(mounted.scratch.path+'/')) return false;
      if (!name.startsWith('/tmp/')) return actual===name;
      const location=view.sandbox===null ? name :
        join(mounted?.privateTmp ?? sandboxPrivateTmp(actor),name.slice(5));
      return actual===location;
    }} : undefined;
    if (['$.lifecycle.start','$.app.forceStart','$.app.restart'].includes(method) && node.type === 'app') {
      if (!this.store.contextAllows(actor,context,node.id,'methods',method,data)) throw Error('Permission denied');
      try { this.check(node,caller); }
      catch (error) {
        if (!caller) this.hooks.failed(node.id,'Manifest: ' + (error as Error).message);
        throw error;
      }
      return {handled:false};
    }
    if (method !== '$.children.createApp' && (node.type !== 'app' ||
        !['$.app.manifest.get','$.app.manifest.getApplied','$.app.manifest.set'].includes(method)))
      return {handled:false};
    if (!this.store.contextAllows(actor,context,node.id,'methods',method,data)) throw Error('Permission denied');
    if (method === '$.app.manifest.get') return {handled:true,result:mask(this.source(node))};
    if (method === '$.app.manifest.getApplied') {
      const result = mask({manifest:node.manifest}) as {manifest:any};
      return {handled:true,result:result.manifest};
    }
    const create = method === '$.children.createApp';
    const source = savedSource(data?.source,create ? undefined : this.source(node));
    const db = this.store.db;
    db.exec('SAVEPOINT update_manifest_source');
    let candidate;
    let changed = false;
    try {
      // Read a file using the new APP's actual permission chain before publishing it.
      if (create) {
        node = this.store.create(node.id,'app',{name:data.name,permissions:data.permissions,profile:data.profile,manifest:{}});
        if (data.httpName !== undefined) this.store.setHttpName(node.id,data.httpName);
      }
      // A delegated installation can be restricted to a package by the source
      // filename in the method permit. A later symlink must not redirect it.
      const allowLinks = this.store.contextAdmin(actor,context);
      candidate = this.candidate(node.id,source,allowLinks,caller);
      changed = !isDeepStrictEqual(candidate,this.pending.get(node.id) ?? node.manifest);
      db.prepare('INSERT INTO manifest_sources(appId,source,allowLinks) VALUES(?,?,?) ON CONFLICT(appId) DO UPDATE SET source=excluded.source,allowLinks=excluded.allowLinks')
        .run(node.id,JSON.stringify(source),Number(allowLinks));
      this.reconcile(node,candidate,false);
      db.exec('RELEASE update_manifest_source');
    } catch (error) {
      db.exec('ROLLBACK TO update_manifest_source; RELEASE update_manifest_source');
      throw error;
    }
    this.watch(node.id,'file' in source ? this.file(node.id,source.file).path : undefined);
    if (create) this.hooks.created?.(node.id);
    if (!create && changed) this.hooks.changed(node.id);
    return {handled:true,result:create ? {id:node.id} : {}};
  }
}
