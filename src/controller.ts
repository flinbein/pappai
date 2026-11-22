import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { prepare } from './manifest.ts';
import { mask as maskSource } from './manifest-sources.ts';
import { matchesName, validNodes, type Rule } from './permits.ts';
import { compileSubscriptions, changeSubscriptions } from './subscriptions.ts';
import { systemDescription } from './system-help.ts';
import { DeliveryReports, type DeliveryNotice } from './delivery-reports.ts';
import type { Store } from './store.ts';
import type { ProcessRunner, Assignment, InputRecord } from './runner.ts';

const DAY = 86_400_000;
type Work = InputRecord & { id:string; data:unknown; priority:number; canEvict:boolean };
type Pending = {
  appId:string; version?:string; item:Work; worker?:string;
  resolve:(value:unknown)=>void; reject:(issue:Error)=>void; timer:NodeJS.Timeout;
};
type Worker = {
  id:string; appId:string; profileId?:string; sandboxState?:string; profileMcpNetwork?:boolean; runnerType:string; persistent:boolean; started:boolean;
  retiring:boolean; profileRevoked?:boolean; stopRequested?:boolean; writing?:string; calls:Set<string>; requests:number; abort:AbortController;
  idleTimeoutMs?:number|null; idle?:NodeJS.Timeout; first?:Work; maxRestarts:number;
};
type Config = ReturnType<typeof prepare>;
type Runner = Pick<EventEmitter,'on'> & Pick<ProcessRunner,'dispatch'|'stop'|'rejectReply'|'deliver'|'respond'|'notify'>;
export type ControllerHooks = {
  system?:(actor:string,node:NonNullable<ReturnType<Store['get']>>,method:string,data:any)=>{handled:boolean;result?:any}|undefined;
  systemNames?:(type:NonNullable<ReturnType<Store['get']>>['type'])=>string[];
  profileCall?:(actor:string,profileId:string,method:string,data:any,callerWorkerId?:string,signal?:AbortSignal,timeoutMs?:number)=>Promise<unknown>;
  profileFeatures?:()=>string[];
  manifestChanged?:(appId:string)=>boolean;
  beforeRestart?:(appId:string)=>void;
  executorStart?:(job:Assignment)=>void;
  executorProfileRevoked?:(workerId:string)=>void;
  executorRetire?:(workerId:string,appId:string)=>void;
  executorExit?:(workerId:string,appId:string)=>void;
  callOpened?:(id:string,actor:string,target:string,params:any,callerWorkerId?:string)=>void;
  callAssigned?:(id:string,workerId:string)=>void;
  callClosed?:(id:string)=>void;
  unfinished?:(id:string)=>boolean;
  executorRequest?:(workerId:string,appId:string,method:string,params:any)=>any;
};
const subscriptionMethods = ['get','set','add','delete','enable','disable'].map(name=>'$.node.subscriptions.' + name);
const appMethods = ['$.app.start','$.app.stop','$.app.restart','$.app.get','$.app.executors.get',
  '$.app.manifest.get','$.app.manifest.getApplied','$.app.manifest.set',...subscriptionMethods];
const appEvents = ['$.app.statusChanged','$.app.restarted','$.app.executor.failed','$.app.manifest.sourceChanged',
  '$.node.subscriptions.updated','$.node.permissions.updated','$.node.lastIssueUpdated','$.node.created'];

function inputIssue(config: Config, method: string, version: unknown, data: unknown) {
  const feature = config.features.get(method);
  if (feature?.type !== 'method') return 'Method not found';
  if (version !== undefined && version !== feature.version) return 'Method version mismatch';
  if (feature.input && !feature.input(data)) return 'Input does not match schema';
}

export class Controller {
  store:Store;
  runner:Runner;
  hooks:ControllerHooks;
  private configs = new Map<string,Config>();
  private pending = new Map<string,Pending>();
  private queues = new Map<string,Work[]>();
  private workers = new Map<string,Worker>();
  private runnersDown = new Map<string,string>();
  private runnersRestarting = new Set<string>();
  private restarting = new Set<string>();
  private releasing = new Set<string>();
  private failures = new Map<string,number>();
  private personal = new Map<string,ReturnType<typeof compileSubscriptions>>();
  private unconfirmed = new Set<string>();
  private reports = new DeliveryReports();
  private userSinks = new Map<string, Set<(item:InputRecord)=>boolean>>();
  private closing = false;

  constructor(store:Store,runner:Runner,hooks:ControllerHooks = {}) {
    this.store = store;
    this.runner = runner;
    this.hooks = hooks;
    runner.on('reply', ({id,appId,workerId = id,result,error}) => {
      const call = this.pending.get(id);
      if (!call || call.appId !== appId || call.worker !== workerId) {
        runner.rejectReply(id,'Call closed',workerId);
        return;
      }
      if (error !== undefined) {
        this.finish(id,Error(typeof error === 'string' ? error : error?.message ?? 'Executor error'));
        return;
      }
      if (hooks.unfinished?.(id)) return runner.rejectReply(id,'File upload unfinished',workerId);
      const check = this.config(appId).features.get(call.item.method!)?.output;
      if (check && !check(result)) return runner.rejectReply(id,'Result does not match output schema',workerId);
      this.finish(id,undefined,result);
    });
    runner.on('started', ({id,appId}) => {
      const worker = this.workers.get(id);
      if (!worker || worker.appId !== appId) return;
      worker.started = true;
      if (worker.profileId) this.revalidateProfiles();
      if (!worker.first || worker.retiring) return;
      const item = worker.first;
      worker.first = undefined;
      if (item.method && !this.pending.has(item.id)) { this.retire(worker,true); return; }
      try { this.runner.deliver(id,item); }
      catch (error) { this.exited({id,appId,issue:(error as Error).message,startFailed:true}); }
    });
    runner.on('written', ({workerId,id,appId}) => {
      const worker = this.workers.get(workerId);
      if (!worker || worker.appId !== appId || worker.writing !== id) return;
      this.reports.finish(id,'delivered');
      worker.writing = undefined;
      if (worker.persistent) this.next(appId);
      this.armIdle(worker);
    });
    runner.on('request', msg => { void this.request(msg); });
    runner.on('exit', msg => this.exited(msg));
    runner.on('restarting', (name:string) => {
      this.runnersRestarting.add(name);
      for (const worker of this.workers.values()) if (worker.runnerType === name) this.retire(worker,false);
    });
    runner.on('lost', (issue:string, name?:string) => {
      if (this.closing) return;
      this.runnersDown.set(name ?? '*',String(issue));
      const ids = new Set<string>();
      for (const app of store.workingApps()) if (!name || this.config(app.id).runnerType === name) ids.add(app.id);
      for (const worker of [...this.workers.values()]) if (!name || worker.runnerType === name) {
        ids.add(worker.appId);
        this.release(worker,String(issue));
      }
      for (const id of ids) {
        const app = store.get(id);
        if (!app) continue;
        if (!name || app.status === 'stopping' || this.config(id).runnerType === name)
          this.failApp(id,String(issue));
        else this.next(id);
      }
    });
  }
  private config(id:string) {
    let config = this.configs.get(id);
    if (!config) {
      config = prepare(this.store.get(id)?.manifest);
      this.configs.set(id,config);
    }
    return config;
  }
  shutdown() {
    this.closing = true;
    this.reports.close();
    for (const id of this.pending.keys()) this.finish(id,Error('Controller shutting down'));
    this.queues.clear();
    for (const worker of this.workers.values()) this.retire(worker,false);
  }
  connectUser(id:string,receive:(item:InputRecord)=>boolean) {
    const sinks = this.userSinks.get(id) ?? new Set();
    this.userSinks.set(id,sinks);
    sinks.add(receive);
    return ()=>{
      sinks.delete(receive);
      if (!sinks.size) this.userSinks.delete(id);
    };
  }
  private instances(appId:string) {
    return [...this.workers.values()].filter(worker=>worker.appId === appId);
  }
  isPersistentRunning(appId:string) { return this.instances(appId).some(w=>w.persistent); }
  isCurrentExecutor(appId:string,id:string) {
    const w = this.workers.get(id);
    return w?.appId === appId && w.started && !w.retiring && this.store.get(appId)?.status === 'working';
  }
  runnerRestarted(name:string) {
    this.runnersDown.delete(name);
    this.runnersRestarting.delete(name);
    for (const w of [...this.workers.values()]) if (w.runnerType === name && w.retiring) {
      this.release(w,'Runner restarted');
      if (this.store.get(w.appId)?.status === 'working' && this.config(w.appId).runnerType !== name)
        this.next(w.appId);
    }
    for (const app of this.store.workingApps()) if (this.config(app.id).runnerType === name) {
      this.emitSystem(app.id,'$.app.restarted',{});
      this.next(app.id);
    }
  }
  private armIdle(worker:Worker) {
    clearTimeout(worker.idle);
    if (this.closing || !worker.persistent || worker.retiring || worker.writing || worker.calls.size || worker.requests ||
      !worker.idleTimeoutMs || this.queues.get(worker.appId)?.length) return;
    worker.idle = setTimeout(()=>this.retire(worker,true),worker.idleTimeoutMs);
    worker.idle.unref();
  }
  private finish(id:string,error?:Error,result?:unknown) {
    const call = this.pending.get(id);
    if (!call) return;
    this.pending.delete(id);
    clearTimeout(call.timer);
    const queue = this.queues.get(call.appId);
    const index = queue?.findIndex(item=>item.id === id) ?? -1;
    if (index >= 0) queue!.splice(index,1);
    if (!queue?.length) this.queues.delete(call.appId);
    const worker = call.worker && this.workers.get(call.worker);
    if (worker) { worker.calls.delete(id); this.armIdle(worker); }
    this.hooks.callClosed?.(id);
    if (error) call.reject(error); else call.resolve(result);
  }
  private clearQueue(id:string,issue:string) {
    const queue = this.queues.get(id) ?? [];
    this.queues.delete(id);
    for (const item of queue) {
      this.reports.finish(item.id,'rejected');
      this.finish(item.id,Error(issue));
    }
  }
  private status(id:string,status:'working'|'stopping'|'stopped'|'error',issue?:string) {
    const previous = this.store.get(id);
    const previousStatus = previous?.status;
    this.store.setStatus(id,status,issue);
    if (previousStatus !== status) this.emitSystem(id,'$.app.statusChanged',{previousStatus,status});
    if (issue && issue !== previous?.lastIssue) this.emitSystem(id,'$.node.lastIssueUpdated',{});
  }
  private failApp(id:string,issue:string) {
    this.restarting.delete(id);
    this.clearQueue(id,issue);
    const status = this.store.get(id)?.status;
    if (status === 'working' || status === 'stopping') this.status(id,'error',issue);
    for (const worker of this.instances(id)) if (worker.first && !worker.retiring) {
      this.finish(worker.first.id,Error(issue));
      this.retire(worker,true);
    }
  }
  manifestFailed(id:string,issue:string) {
    if (this.store.get(id)?.status !== 'working') {
      const app = this.store.get(id);
      if (app) this.store.setStatus(id,app.status,issue);
      return;
    }
    this.failApp(id,issue);
    for (const worker of this.instances(id)) this.retire(worker,true);
  }
  private retire(worker:Worker,stop:boolean) {
    if (!worker.retiring) {
      worker.retiring = true;
      clearTimeout(worker.idle);
      this.hooks.executorRetire?.(worker.id,worker.appId);
    }
    if (stop && !worker.stopRequested) {
      worker.stopRequested=true;
      try { this.runner.stop(worker.id); }
      catch (error) { this.exited({id:worker.id,appId:worker.appId,stopFailed:true,issue:(error as Error).message}); }
    }
  }
  private revalidateProfiles() {
    for (const worker of [...this.workers.values()]) {
      const app=this.store.get(worker.appId);
      if (!app || (!app.profile && !worker.profileId)) continue;
      const changed=(app.profile ?? undefined)!==worker.profileId;
      let denied=false;
      try {
        const sandbox=this.store.sandbox(app.id);
        if (!changed && worker.sandboxState===JSON.stringify(sandbox) && (worker.profileMcpNetwork===undefined ||
          worker.profileMcpNetwork===this.store.profileMcpNetwork(app,sandbox?.network ?? true))) continue;
      } catch { denied=true; }
      if (!worker.profileRevoked) {
        worker.profileRevoked=true;
        this.hooks.executorProfileRevoked?.(worker.id);
      }
      this.retire(worker,true);
      if (!changed && denied && worker.persistent) this.failApp(app.id,'Profile does not permit this APP');
    }
  }
  private release(worker:Worker,issue:string) {
    this.workers.delete(worker.id);
    this.reports.finish(worker.writing,worker.first ? 'rejected' : 'unknown');
    worker.abort.abort();
    clearTimeout(worker.idle);
    for (const id of worker.calls) this.finish(id,Error(issue));
    this.hooks.executorExit?.(worker.id,worker.appId);
  }
  private exited(message:{id:string;appId:string;issue?:string;startFailed?:boolean;stopFailed?:boolean;permanent?:boolean}) {
    const {appId} = message;
    const alreadyReleasing = this.releasing.has(appId);
    this.releasing.add(appId);
    try { this.handleExit(message); }
    finally {
      if (!alreadyReleasing) {
        this.releasing.delete(appId);
        this.next(appId);
      }
    }
  }
  private handleExit({id,appId,issue,startFailed,stopFailed,permanent}:any) {
    const worker = this.workers.get(id);
    if (!worker || worker.appId !== appId) return;
    const reason = issue ?? (worker.calls.size ? 'Executor exited without a reply' : undefined);
    this.release(worker,reason ?? 'Executor exited');
    if (this.closing) return;
    const app = this.store.get(appId);
    if (!app) return;
    if (stopFailed) { this.unconfirmed.add(appId); this.failApp(appId,reason ?? 'Executor stop failed'); return; }
    if (app.status === 'stopping') {
      if (!this.instances(appId).length) this.status(appId,'stopped');
      return;
    }
    if (app.status !== 'working') return;
    if (this.restarting.has(appId) && !this.isPersistentRunning(appId)) this.completeRestart(appId);
    else if (!worker.retiring && reason) {
      this.status(appId,'working',reason);
      if (startFailed && (!worker.persistent || permanent)) { this.failApp(appId,reason); return; }
      if (worker.persistent) {
        const previous = this.failures.get(appId) ?? 0;
        this.failures.set(appId,previous + 1);
        if (previous >= worker.maxRestarts) { this.failApp(appId,reason); return; }
        this.emitSystem(appId,'$.app.executor.failed',{},appId);
      }
    }
    if (!reason && worker.persistent) this.failures.delete(appId);
    this.next(appId);
  }
  private completeRestart(appId:string) {
    this.restarting.delete(appId);
    this.emitSystem(appId,'$.app.restarted',{});
    this.next(appId);
  }
  private enqueue(appId:string,item:Work) {
    const queue = this.queues.get(appId) ?? [];
    if (queue.length >= 100) {
      if (!item.canEvict) return false;
      const minimum = queue[queue.length-1].priority;
      if (minimum > item.priority) return false;
      const [dropped] = queue.splice(queue.findIndex(other=>other.priority === minimum),1);
      this.reports.finish(dropped.id,'rejected');
      this.finish(dropped.id,Error('Call evicted from queue'));
    }
    const offset = queue.findIndex(other=>other.priority < item.priority);
    queue.splice(offset < 0 ? queue.length : offset,0,item);
    this.queues.set(appId,queue);
    this.next(appId);
    return true;
  }
  private assignCall(id:string,worker:Worker) {
    const pending=this.pending.get(id);
    if (!pending) return;
    worker.calls.add(id);
    pending.worker=worker.id;
    clearTimeout(worker.idle);
    this.hooks.callAssigned?.(id,worker.id);
  }
  private next(appId:string) {
    const queue = this.queues.get(appId);
    if (this.closing || !queue?.length || this.restarting.has(appId) || this.releasing.has(appId) ||
      this.runnersDown.has('*') || this.store.get(appId)?.status !== 'working') return;
    const config = this.config(appId);
    if (this.runnersRestarting.has(config.runnerType) || this.runnersDown.has(config.runnerType)) return;
    const current = this.instances(appId);
    const existing = current.find(w=>w.persistent);
    if (existing && (existing.retiring || existing.writing || config.mode !== 'persistent')) return;
    if (!existing && current.length >= config.poolSize) return;
    const app=this.store.get(appId)!;
    if (app.profile) {
      try { this.store.profileFor(app); }
      catch (err) { this.failApp(appId,(err as Error).message); return; }
    }
    const item = queue.shift()!;
    if (!queue.length) this.queues.delete(appId);
    const worker:Worker = existing ?? {
      id:item.id,appId,profileId:app.profile ?? undefined,runnerType:config.runnerType,persistent:config.mode === 'persistent',started:false,
      retiring:false,calls:new Set(),requests:0,abort:new AbortController(),idleTimeoutMs:config.idleTimeoutMs,
      maxRestarts:config.maxRestarts ?? 0,first:config.runnerType === 'process' || app.profile ? item : undefined,
    };
    this.workers.set(worker.id,worker);
    worker.writing = item.id;
    clearTimeout(worker.idle);
    try {
      this.assignCall(item.id,worker);
      if (existing) this.runner.deliver(worker.id,item);
      else {
        const {priority,canEvict,...input} = item;
        const job:Assignment = {...input,appId,...(worker.profileId && {profileId:worker.profileId}),runnerType:config.runnerType,mode:config.mode,
          holdFirst:!!worker.first,settings:{...config.settings,...(config.settings.env && {env:{...config.settings.env}})},
          sandbox:this.store.sandbox(appId),maxLifetimeMs:config.maxLifetimeMs};
        if (worker.profileId) {
          worker.sandboxState=JSON.stringify(job.sandbox);
          job.profileMcpNetwork=this.store.profileMcpNetwork(app,job.sandbox?.network ?? true);
          const mcp=job.settings.mcp;
          if (mcp && typeof mcp==='object' && 'profile' in mcp && Array.isArray(mcp.profile) && mcp.profile.length) {
            worker.profileMcpNetwork=job.profileMcpNetwork;
            // Older runners use the selection directly. Keep their input bounded, including when registered under an alias.
            if (!job.profileMcpNetwork) job.settings.mcp={...mcp,profile:[]};
          }
        }
        this.hooks.executorStart?.(job);
        this.runner.dispatch(job);
      }
    } catch (error) {
      this.exited({id:worker.id,appId,issue:(error as Error).message,startFailed:!existing});
    }
    if (!worker.persistent && queue.length && this.store.get(appId)?.status === 'working') this.next(appId);
  }
  async call(actor:string,params:any,signal?:AbortSignal):Promise<any> {
    return this.invoke(actor,params,signal);
  }
  private async invoke(actor:string,params:any,signal?:AbortSignal,worker?:Worker):Promise<any> {
    if (this.closing) throw Error('Controller shutting down');
    const {node:appId,method,data,version} = params;
    if (typeof appId !== 'string' || typeof method !== 'string') throw Error('Expected node and method');
    const permitted = worker && !method.startsWith('$.') && this.workers.get(worker.id) === worker
      ? this.store.allowsLiveExecutor(actor,appId,method,data)
      : this.store.allows(actor,appId,method,data);
    if (!permitted) throw Error('Permission denied');
    const app = this.store.get(appId);
    if (!app) throw Error('Node not found');
    if (app.type==='profile' && !method.startsWith('$.') && this.hooks.profileCall)
      return this.hooks.profileCall(actor,app.id,method,data ?? {},worker?.id,signal,params.timeoutMs);
    if (method.startsWith('$.')) return this.system(actor,app,method,data ?? {});
    if (app.type !== 'app' || app.status !== 'working') throw Error('APP is not working');
    const config = this.config(appId);
    const issue = inputIssue(config,method,version,data);
    if (issue) throw Error(issue);
    if (Buffer.byteLength(JSON.stringify({method,data})) > 10 * 1024) throw Error('Input too large');
    const timeout = params.timeoutMs ?? DAY;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > DAY) throw Error('Invalid timeout');
    if (signal?.aborted) throw Error('Call cancelled');
    // Interrupting a busy turn cannot wait behind that same turn in the queue.
    let interrupt:Worker|undefined;
    if (config.runnerType==='codex' && config.mode==='persistent' && method==='agent.interrupt') {
      if (app.profile) this.store.profileFor(app);
      interrupt=this.instances(appId).find(w=>w.runnerType==='codex' && w.persistent && w.started && !w.retiring &&
        w.profileId===(app.profile ?? undefined));
      if (!interrupt) throw Error('No active Codex turn');
      if (interrupt.calls.size>=100) throw Error('Too many pending calls');
    }
    const id = randomUUID();
    const feature = config.features.get(method)!;
    const item = {id,from:actor,method,data,...(feature.schema?.output !== undefined && {outputSchema:feature.schema.output}),priority:feature.priority ?? 0,canEvict:feature.canEvict ?? false};
    const cancel = (issue:string) => {
      const assigned=this.pending.get(id)?.worker;
      if (!interrupt && assigned && this.workers.get(assigned)?.runnerType!=='process') {
        try { this.runner.notify(assigned,{cancelled:id}); } catch { /* Runner disconnected. */ }
      }
      this.finish(id,Error(issue));
    };
    const abort = () => cancel('Call cancelled');
    this.hooks.callOpened?.(id,actor,appId,params,worker?.id);
    try {
      return await new Promise((resolve,reject) => {
        const timer = setTimeout(()=>cancel('Call timed out'),timeout);
        this.pending.set(id,{appId,item,version,timer,resolve,reject});
        signal?.addEventListener('abort',abort,{once:true});
        if (interrupt) {
          try {
            this.assignCall(id,interrupt);
            this.runner.notify(interrupt.id,{interrupt:id});
          } catch (error) { this.finish(id,error as Error); }
        } else if (!this.enqueue(appId,item)) this.finish(id,Error('Queue full'));
      });
    } finally { signal?.removeEventListener('abort',abort); }
  }
  private async request({workerId,appId,id,method,params}:any) {
    const worker = this.workers.get(workerId);
    if (!worker || worker.appId !== appId) return;
    clearTimeout(worker.idle);
    worker.requests++;
    let response:{result?:unknown;error?:unknown};
    try {
      if (worker.profileRevoked || worker.profileId!==(this.store.get(appId)?.profile ?? undefined))
        throw Error('Profile access revoked');
      if (worker.profileId) this.store.profileFor(this.store.get(appId)!);
      let result;
      switch (method) {
        case 'call': result = await this.invoke(appId,params,worker.abort.signal,worker); break;
        case 'publish':
          result = await this.sendEvent(appId,params,update=>{
            if (this.workers.get(workerId) !== worker) return;
            try { this.runner.notify(workerId,{delivery:update}); } catch { /* Publisher disconnected. */ }
          },worker.abort.signal,worker);
          break;
        case 'help': result = this.help(appId,params); break;
        case 'dir': result = this.store.visible(appId); break;
        default:
          if (!this.hooks.executorRequest) throw Error('Unknown executor request');
          result = await this.hooks.executorRequest(workerId,appId,method,params);
      }
      response = {result:result ?? null};
    } catch (error) { response = {error:{message:(error as Error).message}}; }
    worker.requests--;
    if (this.workers.get(workerId) !== worker) return;
    try { this.runner.respond(workerId,id,response); } catch { /* Transport loss is handled by the runner. */ }
    this.armIdle(worker);
  }
  publish(actor:string,params:any,notify?:(update:DeliveryNotice)=>void,signal?:AbortSignal) {
    return this.sendEvent(actor,params,notify,signal);
  }
  private sendEvent(actor:string,params:any,notify?:(update:DeliveryNotice)=>void,signal?:AbortSignal,worker?:Worker) {
    if(this.closing) throw Error('Controller shutting down');
    const {event,data,version,to,delivery='none'} = params;
    const app = this.store.get(actor);
    if (typeof event !== 'string' || !/^[\w-]+(?:\.[\w-]+)*$/.test(event) || !app ||
        !['app','user'].includes(app.type) || (app.status !== 'working' && (!worker || this.workers.get(worker.id) !== worker)))
      throw Error('Invalid event publication');
    if (app.type === 'app') {
      const feature = this.config(actor).features.get(event);
      if (feature?.type !== 'event') throw Error('Event not found');
      if (version !== undefined && feature.version !== version) throw Error('Event version mismatch');
      if (feature.data && !feature.data(data)) throw Error('Event data does not match schema');
    }
    if (to !== undefined && !validNodes(to)) throw Error('Invalid event recipient');
    if (Buffer.byteLength(JSON.stringify({event,data})) > 10 * 1024) throw Error('Event too large');
    if (!['none','status','track'].includes(delivery)) throw Error('Invalid delivery mode');
    const timeout = params.timeoutMs ?? DAY;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > DAY) throw Error('Invalid delivery timeout');
    const report = delivery === 'none' ? undefined : this.reports.begin(randomUUID(),delivery,timeout,
      node=>this.store.allowsDelivery(actor,node),notify,signal);
    this.route(actor,event,data,to,report);
    return report?.result() ?? {};
  }
  emitSystem(source:string,event:string,data:unknown,to?:string) { this.route(source,event,data,to); }
  private route(from:string,event:string,data:unknown,to?:Rule['node'],report?:ReturnType<DeliveryReports['begin']>) {
    if (this.closing) return;
    const apps = (this.store.eventRecipients?.() ?? this.store.workingApps()).filter(app=>to === undefined ||
      app.id === to || this.store.selects?.(from,app.id,to));
    const accepted = new Map<string,boolean>();
    const deliver = (appId:string):boolean => {
      if (accepted.has(appId)) return accepted.get(appId)!;
      // A dependency cycle treats the in-progress recipient as uncaught.
      accepted.set(appId,false);
      report?.set(appId,'rejected');
      if (!this.store.allowsEvent?.(appId,from,event,data)) return false;
      if (this.store.get(appId)?.type === 'user') {
        let received = false;
        for (const receive of this.userSinks.get(appId) ?? []) if (receive({from,event,data})) received = true;
        accepted.set(appId,received);
        if (received) report?.set(appId,'delivered');
        return received;
      }
      let personal = this.personal.get(appId);
      if (!personal) {
        personal = compileSubscriptions(this.store.getSubscriptions(appId),true);
        this.personal.set(appId,personal);
      }
      for (const rule of [...this.config(appId).subscriptions,...personal]) {
        if (!rule.enabled || !rule.matches(event,data) || !this.store.selects(appId,from,rule.node ?? true,rule.nodeType)) continue;
        if (rule.caughtBy !== undefined && !apps.some(other=>other.id !== appId &&
            this.store.selects(appId,other.id,rule.caughtBy) && this.store.allowsDelivery(appId,other.id) && deliver(other.id))) continue;
        if (rule.deny) break;
        if (event === '$.app.manifest.sourceChanged' && this.queues.get(appId)?.some(item=>item.event === event && item.from === from)) {
          accepted.set(appId,true);
          return true;
        }
        const id = randomUUID();
        report?.watch(appId,id);
        if (this.enqueue(appId,{id,from,event,data,subscription:rule.id,priority:rule.priority,canEvict:rule.canEvict})) {
          accepted.set(appId,true);
          return true;
        }
        report?.discard(id);
        report?.set(appId,'rejected');
      }
      return false;
    };
    for (const app of apps) deliver(app.id);
  }
  applyManifest(appId:string,manifest:any,save?:()=>void) {
    const config = prepare(manifest);
    const rejected = new Map<string,string>();
    for (const [id,call] of this.pending) {
      if (call.appId !== appId) continue;
      const method = call.item.method!;
      const issue = call.worker
        ? (config.features.get(method)?.type === 'method' ? undefined : 'Method not found')
        : inputIssue(config,method,call.version,call.item.data);
      if (issue) rejected.set(id,issue);
    }
    if (save) save(); else this.store.setManifest(appId,manifest);
    this.configs.set(appId,config);
    for (const [id,issue] of rejected) this.finish(id,Error(issue));
    this.next(appId);
  }
  private system(actor:string,node:NonNullable<ReturnType<Store['get']>>,method:string,data:any):any {
    const external = this.hooks.system?.(actor,node,method,data);
    if (external?.handled) return external.result;
    const managed = this.store.manage?.(actor,node.id,method,data);
    if (managed?.handled) {
      if (!method.endsWith('.get') && !method.endsWith('.list')) this.revalidateProfiles();
      if (method === '$.node.permissions.set') this.emitSystem(node.id,'$.node.permissions.updated',{});
      return managed.result;
    }
    if (node.type === 'app' && subscriptionMethods.includes(method)) {
      const action = method.split('.').at(-1)!;
      const current = this.store.getSubscriptions(node.id);
      if (action === 'get') return {subscriptions:current};
      const next = changeSubscriptions(current,action,data);
      if (JSON.stringify(next) !== JSON.stringify(current)) {
        this.store.setSubscriptions(node.id,next);
        this.personal.delete(node.id);
        this.emitSystem(node.id,'$.node.subscriptions.updated',{});
      }
      return {};
    }
    if (['$.app.create','$.team.create','$.user.create','$.profile.create'].includes(method)) {
      if (method!=='$.profile.create' && !this.store.isAdmin(actor)) throw Error('Permission denied');
      if (!['workspace','team'].includes(node.type)) throw Error('Parent must be a workspace or TEAM');
      const type = method.split('.')[1] as 'app'|'team'|'user'|'profile';
      const config = type === 'app' ? prepare(data.source?.manifest) : undefined;
      const created = this.store.create(node.id,type,{
        name:data.name,email:data.email,profile:data.profile,scope:data.scope,...(Object.hasOwn(data,'permissions') ? {permissions:data.permissions} : {}),
        ...(config ? {manifest:data.source.manifest} : {}),
      });
      if (config) this.configs.set(created.id,config);
      this.emitSystem(created.id,'$.node.created',{status:created.status});
      return {id:created.id};
    }
    if (method === '$.app.start' && ['app','user'].includes(node.type)) {
      if (node.status === 'stopping') throw Error('APP is stopping');
      if (node.status === 'working') return {};
      if (node.type === 'app') {
        const runnerIssue = this.runnersDown.get('*') ?? this.runnersDown.get(this.config(node.id).runnerType);
        if (runnerIssue) throw Error(runnerIssue);
        if (this.unconfirmed.has(node.id) && data.force !== true) throw Error('Previous executor exit unconfirmed; force required');
        this.unconfirmed.delete(node.id);
        this.failures.delete(node.id);
      }
      this.status(node.id,'working');
      return {};
    }
    if (node.type === 'app') {
      const workers = this.instances(node.id);
      switch (method) {
        case '$.app.get':
          return {status:node.status,lastIssue:node.lastIssue,...(node.profile && {profile:node.profile}),manifestChanged:this.hooks.manifestChanged?.(node.id) ?? false};
        case '$.app.executors.get': {
          const config = this.config(node.id);
          return {mode:config.mode,active:workers.length,limit:config.mode === 'persistent' ? null : config.poolSize,
            queued:this.queues.get(node.id)?.length ?? 0,restarting:this.restarting.has(node.id) || this.runnersRestarting.has(config.runnerType)};
        }
        case '$.app.stop':
          if (node.status === 'stopped' || node.status === 'stopping') return {};
          this.restarting.delete(node.id);
          this.status(node.id,workers.length ? 'stopping' : 'stopped');
          this.clearQueue(node.id,'APP stopped');
          for (const worker of workers) this.retire(worker,true);
          return {};
        case '$.app.restart':
          if (node.status !== 'working') throw Error('APP is not working');
          if (this.restarting.has(node.id)) return {};
          this.restarting.add(node.id);
          try { this.hooks.beforeRestart?.(node.id); }
          catch (error) { this.restarting.delete(node.id); throw error; }
          this.failures.delete(node.id);
          if (!this.isPersistentRunning(node.id)) this.completeRestart(node.id);
          else for (const worker of workers) if (worker.persistent) this.retire(worker,true);
          return {};
        case '$.app.manifest.get': return maskSource({manifest:node.manifest});
        case '$.app.manifest.getApplied': return maskSource({manifest:node.manifest}).manifest;
        case '$.app.manifest.set':
          if (!this.store.isAdmin(actor)) throw Error('Permission denied');
          if (!data.source || Object.keys(data.source).length !== 1 || !Object.hasOwn(data.source,'manifest'))
            throw Error('Expected an inline manifest source');
          this.applyManifest(node.id,data.source.manifest);
          return {};
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
        ? ['$.team.create', '$.user.create', '$.app.create', '$.profile.create']
        : app.type === 'app' ? appMethods : app.type==='profile' ? this.hooks.profileFeatures?.() ?? [] : ['$.app.start'];
    for (const name of [...core,...(this.store.managementNames?.(app.type) ?? []),...(this.hooks.systemNames?.(app.type) ?? [])])
      entries.set(name, {
        type: 'method',
        version: '1',
        description: systemDescription(name),
      });
    const events = app.type === 'app' ? appEvents : app.type === 'workspace' ? ['$.workspace.init'] : ['$.node.created','$.node.permissions.updated'];
    for (const name of events) entries.set(name,{type:'event',version:'1',description:systemDescription(name)});
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
