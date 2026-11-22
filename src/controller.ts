import { randomUUID } from 'node:crypto';
import { prepare } from './manifest.ts';
import { matchesName } from './permits.ts';
import type { Store } from './store.ts';
import type { ProcessRunner } from './runner.ts';

const DAY = 86_400_000;
type Pending = {
  id: string;
  appId: string;
  from: string;
  method: string;
  version?: string;
  data: any;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};
type Config = ReturnType<typeof prepare>;
const appMethods = ['$.app.start', '$.app.stop', '$.app.get', '$.app.executors.get',
  '$.app.manifest.get', '$.app.manifest.getApplied', '$.app.manifest.set'];

function inputIssue(config: Config, method: string, version: unknown, data: unknown) {
  const feature = config.features.get(method);
  if (feature?.type !== 'method') return 'Method not found';
  if (version !== undefined && version !== feature.version) return 'Method version mismatch';
  if (feature.input && !feature.input(data)) return 'Input does not match schema';
}
export class Controller {
  store: Store;
  runner: ProcessRunner;
  private configs = new Map<string, ReturnType<typeof prepare>>();
  private pending = new Map<string, Pending>();
  private queues = new Map<string, string[]>();
  private active = new Map<string, string>();
  private runnerIssue?: string;

  constructor(store: Store, runner: ProcessRunner) {
    this.store = store;
    this.runner = runner;
    runner.on('reply', ({ id, appId, result, error }) => {
      const call = this.pending.get(id);
      if (!call || call.appId !== appId || this.active.get(appId) !== id) {
        runner.rejectReply(id, 'Call closed');
        return;
      }
      if (error !== undefined)
        return this.finish(
          id,
          new Error(typeof error === 'string' ? error : (error?.message ?? 'Executor error')),
        );
      const check = this.config(appId).features.get(call.method)?.output;
      if (check && !check(result)) {
        runner.rejectReply(id, 'Result does not match output schema');
        return;
      }
      this.finish(id, undefined, result);
    });
    runner.on('exit', ({ id, appId, issue, startFailed, stopFailed }) => {
      if (this.active.get(appId) !== id) return;
      this.active.delete(appId);
      this.finish(id, new Error(issue ?? 'Executor exited without a reply'));
      const app = this.store.get(appId);
      if (stopFailed) this.failApp(appId, issue);
      else if (app?.status === 'stopping') this.store.setStatus(appId, 'stopped');
      else if (startFailed) this.failApp(appId, issue ?? 'Executor launch failed');
      else if (app?.status === 'working') {
        if (issue) this.store.setStatus(appId, 'working', issue);
        this.next(appId);
      }
    });
    runner.on('lost', (issue: string) => {
      this.runnerIssue = issue;
      const ids = new Set([...this.active.keys(), ...this.queues.keys()]);
      for (const app of store.workingApps()) ids.add(app.id);
      this.active.clear();
      for (const id of ids) this.failApp(id, String(issue));
    });
  }
  private config(id: string) {
    let config = this.configs.get(id);
    if (!config) {
      config = prepare(this.store.get(id)?.manifest);
      this.configs.set(id, config);
    }
    return config;
  }
  private finish(id: string, error?: Error, result?: any) {
    const call = this.pending.get(id);
    if (!call) return;
    this.pending.delete(id);
    clearTimeout(call.timer);
    const queue = this.queues.get(call.appId);
    const index = queue?.indexOf(id) ?? -1;
    if (index >= 0) queue!.splice(index, 1);
    if (queue?.length === 0) this.queues.delete(call.appId);
    if (error) call.reject(error);
    else call.resolve(result);
  }
  private failApp(id: string, issue: string) {
    const status = this.store.get(id)?.status;
    if (status === 'working' || status === 'stopping') this.store.setStatus(id, 'error', issue);
    for (const call of this.pending.values())
      if (call.appId === id) this.finish(call.id, new Error(issue));
  }
  private next(appId: string) {
    if (this.active.has(appId)) return;
    const list = this.queues.get(appId);
    const id = list?.shift();
    if (!id) return;
    if (!list!.length) this.queues.delete(appId);
    const call = this.pending.get(id)!;
    try {
      const config = this.config(appId);
      this.active.set(appId, id);
      this.runner.dispatch({
        id,
        appId,
        from: call.from,
        method: call.method,
        data: call.data,
        settings: config.settings,
        sandbox: this.store.sandbox(appId),
        maxLifetimeMs: config.maxLifetimeMs,
      });
    } catch (error) {
      this.active.delete(appId);
      this.failApp(appId, (error as Error).message);
    }
  }
  async call(actor: string, params: any, signal?: AbortSignal): Promise<any> {
    const { node: appId, method, data, version } = params;
    if (typeof appId !== 'string' || typeof method !== 'string') throw Error('Expected node and method');
    if (!this.store.allows(actor, appId, method)) throw Error('Permission denied');
    const app = this.store.get(appId);
    if (!app) throw Error('Node not found');
    if (method.startsWith('$.')) return this.system(actor, app, method, data ?? {});
    if (app.type !== 'app' || app.status !== 'working') throw Error('APP is not working');
    const issue = inputIssue(this.config(appId), method, version, data);
    if (issue) throw Error(issue);
    if (Buffer.byteLength(JSON.stringify({ method, data })) > 10 * 1024) throw Error('Input too large');
    const timeout = params.timeoutMs ?? DAY;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > DAY) throw Error('Invalid timeout');
    if (signal?.aborted) throw Error('Call cancelled');
    const queue = this.queues.get(appId) ?? [];
    if (queue.length >= 100) throw Error('Queue full');
    const id = randomUUID();
    const abort = () => this.finish(id, new Error('Call cancelled'));
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => this.finish(id, new Error('Call timed out')), timeout);
        this.pending.set(id, { id, appId, from: actor, method, version, data, timer, resolve, reject });
        signal?.addEventListener('abort', abort, { once: true });
        queue.push(id);
        this.queues.set(appId, queue);
        this.next(appId);
      });
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
  private system(actor: string, node: any, method: string, data: any) {
    if (!this.store.isAdmin(actor)) throw Error('Permission denied');
    if (['$.app.create', '$.team.create', '$.user.create'].includes(method)) {
      if (!['workspace', 'team'].includes(node.type)) throw Error('Parent must be a workspace or TEAM');
      const type = method.split('.')[1] as 'app' | 'team' | 'user';
      let config;
      if (type === 'app') config = prepare(data.source?.manifest);
      const created = this.store.create(node.id, type, {
        name: data.name,
        email: data.email,
        ...(Object.hasOwn(data, 'permissions') ? { permissions: data.permissions } : {}),
        ...(config ? { manifest: data.source.manifest } : {}),
      });
      if (config) this.configs.set(created.id, config);
      return { id: created.id };
    }
    if (method === '$.app.start' && ['app', 'user'].includes(node.type)) {
      if (node.status === 'stopping') throw Error('APP is stopping');
      if (node.type === 'app') {
        if (this.runnerIssue) throw Error(this.runnerIssue);
        this.config(node.id);
      }
      this.store.setStatus(node.id, 'working');
      return {};
    }
    if (node.type === 'app') {
      const active = this.active.get(node.id);
      switch (method) {
        case '$.app.get':
          return {status: node.status, lastIssue: node.lastIssue, manifestChanged: false};
        case '$.app.executors.get':
          return {mode: 'oneShot', active: active ? 1 : 0, limit: 1,
            queued: this.queues.get(node.id)?.length ?? 0, restarting: false};
        case '$.app.stop':
          if (node.status === 'stopped' || node.status === 'stopping') return {};
          this.store.setStatus(node.id, active ? 'stopping' : 'stopped');
          for (const id of [...(this.queues.get(node.id) ?? [])]) this.finish(id, Error('APP stopped'));
          if (active) {
            try { this.runner.stop(active); }
            catch (error) { this.failApp(node.id, (error as Error).message); }
          }
          return {};
        case '$.app.manifest.get': return {manifest: node.manifest};
        case '$.app.manifest.getApplied': return node.manifest;
        case '$.app.manifest.set': {
          if (!data.source || Object.keys(data.source).length !== 1 || !Object.hasOwn(data.source,'manifest'))
            throw Error('Expected an inline manifest source');
          const config = prepare(data.source.manifest);
          const rejected = new Map<string, string>();
          for (const id of this.queues.get(node.id) ?? []) {
            const call = this.pending.get(id)!;
            const issue = inputIssue(config, call.method, call.version, call.data);
            if (issue) rejected.set(id, issue);
          }
          const assigned = active && this.pending.get(active);
          if (assigned && config.features.get(assigned.method)?.type !== 'method')
            rejected.set(assigned.id, 'Method not found');
          this.store.setManifest(node.id, data.source.manifest);
          this.configs.set(node.id, config);
          for (const [id, issue] of rejected) this.finish(id, Error(issue));
          return {};
        }
      }
    }
    throw Error('Unknown system method');
  }
  help(actor: string, params: any) {
    const app = this.store.get(params.node);
    if (!app || !this.store.canDiscover(actor, params.node)) return {};
    const entries = new Map(app.type === 'app' ? this.config(app.id).features : []);
    const core =
      app.type === 'workspace' || app.type === 'team'
        ? ['$.team.create', '$.user.create', '$.app.create']
        : app.type === 'app' ? appMethods : ['$.app.start'];
    for (const name of core)
      entries.set(name, {
        type: 'method',
        version: '1',
        description: name.split('.').slice(1).join(' '),
      });
    const result: Record<string, any> = { versions: Object.create(null) };
    const supplied = ['features', 'schemas', 'docs'].some((k) => Object.hasOwn(params, k));
    for (const section of ['features', 'schemas', 'docs']) {
      if ((supplied && !Object.hasOwn(params, section)) || (!supplied && section !== 'features'))
        continue;
      const selected = params[section] ?? '**';
      const patterns = Array.isArray(selected) ? selected : [selected];
      if (!patterns.every((v) => typeof v === 'string')) throw Error('Invalid help filter');
      const values = Object.create(null);
      for (const [name, f] of entries) {
        if (!matchesName(patterns, name)) continue;
        if (!supplied && [...entries.keys()].some((parent) => name.startsWith(parent + '.'))) continue;
        const value =
          section === 'features'
            ? f.type.toUpperCase() + ';' + f.description
            : section === 'schemas'
              ? f.schema
              : f.doc;
        if (value !== undefined) {
          values[name] = value;
          result.versions[name] = f.version;
        }
      }
      result[section] = values;
    }
    return result;
  }
}
