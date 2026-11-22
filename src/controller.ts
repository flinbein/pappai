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
  data: any;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};
export class Controller {
  store: Store;
  runner: ProcessRunner;
  private configs = new Map<string, ReturnType<typeof prepare>>();
  private pending = new Map<string, Pending>();
  private queues = new Map<string, string[]>();
  private active = new Map<string, string>();

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
    runner.on('exit', ({ id, appId, issue, startFailed }) => {
      if (this.active.get(appId) !== id) return;
      this.active.delete(appId);
      this.finish(id, new Error(issue ?? 'Executor exited without a reply'));
      if (startFailed) this.failApp(appId, issue ?? 'Executor launch failed');
      else this.next(appId);
    });
    runner.on('lost', (issue: string) => {
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
    if (this.store.get(id)?.status === 'working') this.store.setStatus(id, 'error', issue);
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
    const feature = this.config(appId).features.get(method);
    if (feature?.type !== 'method') throw Error('Method not found');
    if (version !== undefined && version !== feature.version) throw Error('Method version mismatch');
    if (feature.input && !feature.input(data)) throw Error('Input does not match schema');
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
        this.pending.set(id, { id, appId, from: actor, method, data, timer, resolve, reject });
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
      if (node.type === 'app') this.config(node.id);
      this.store.setStatus(node.id, 'working');
      return {};
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
        : ['$.app.start'];
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
