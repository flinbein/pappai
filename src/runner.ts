import { fork, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export type Sandbox = {read: string[]; write: string[]; network: boolean} | null;
export type InputRecord = {from:string; method?:string; event?:string; id?:string; data?:unknown; subscription?:string; outputSchema?:unknown};
export type RunnerSettings = Record<string,unknown> & {env?: Record<string,string>};
export type ProcessSettings = RunnerSettings & {cwd:string;command:string;args?:string[]};
export type Assignment<Settings extends RunnerSettings = RunnerSettings> = {
  appId: string; id: string; from: string; method?: string; event?:string; data: unknown; subscription?:string;
  settings: Settings;
  profileId?: string; profileMcpNetwork?: boolean; outputSchema?:unknown;
  sandbox: Sandbox; maxLifetimeMs?: number; mode?: 'oneShot'|'persistent'; runnerType?:string;
  holdFirst?: boolean;
  runtimeMounts?:Array<{source:string;target:string;readonly:boolean}>;
};
export class ProcessRunner extends EventEmitter {
  #host: ChildProcess;
  #closed: Promise<void>;
  #closing = false;
  #lost = false;

  constructor(entrypoint = new URL('./runner-host.ts', import.meta.url), config = '{}', name = 'process', directory = '') {
    super();
    this.#host = fork(entrypoint, [], {
      env:{...process.env,PAPPAI_RUNNER_CONFIG:config,PAPPAI_RUNNER_NAME:name,PAPPAI_RUNNER_DIR:directory},
      execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    this.#closed = new Promise(resolve => this.#host.once('close', () => resolve()));
    this.#host.on('message', (msg: any) => {
      if (msg?.type === 'runnerReply' && typeof msg.payload?.id === 'string') {
        this.emit('adminReply:'+msg.payload.id,msg.payload);
      } else if (['reply','exit','started','written','request','profileMethods','profileRead','profileReply','runnerReady'].includes(msg?.type) && msg.payload) this.emit(msg.type, msg.payload);
    });
    this.#host.once('error', error => this.#reportLoss(error.message));
    this.#host.once('disconnect', () => this.#reportLoss('IPC disconnected'));
    this.#host.once('exit', (code, signal) => this.#reportLoss(String(signal ?? code)));
  }

  get pid() { return this.#host.pid; }

  #reportLoss(reason: string) {
    if (this.#lost || this.#closing) return;
    this.#lost = true;
    this.emit('lost', 'process runner unavailable: ' + reason);
  }

  #send(message: object) {
    if (!this.#host.connected || this.#lost || this.#closing) throw new Error('process runner unavailable');
    this.#host.send(message, error => { if (error) this.#reportLoss(error.message); });
  }

  dispatch(job: Assignment) { this.#send({type: 'dispatch', job}); }
  profileSend(message:object) { this.#send(message); }
  adminCall(method:string,data:unknown,signal:AbortSignal|undefined,timeoutMs:number) {
    if (this.#closing || signal?.aborted) throw Error('Runner operation cancelled');
    const id=randomUUID();
    return new Promise<unknown>((resolve,reject)=>{
      const cleanup=()=>{
        clearTimeout(timer);
        this.off('adminReply:'+id,reply);
        this.off('lost',lost);
        this.off('closing',lost);
        signal?.removeEventListener('abort',cancel);
      };
      const fail=(reason:string)=>{cleanup(); reject(Error(reason));};
      const lost=()=>fail('Runner unavailable');
      const cancel=()=>fail('Runner operation cancelled');
      const reply=({result,error}:{result?:unknown;error?:string})=>{
        cleanup();
        if (error !== undefined) reject(Error(String(error))); else resolve(result);
      };
      const timer=setTimeout(()=>fail('Runner operation timed out'),timeoutMs);
      this.once('adminReply:'+id,reply);
      this.once('lost',lost);
      this.once('closing',lost);
      signal?.addEventListener('abort',cancel,{once:true});
      try { this.#send({type:'runnerCall',id,method,data}); } catch { lost(); }
    });
  }
  deliver(workerId:string,item:InputRecord) { this.#send({type:'deliver', id:workerId, item}); }
  notify(workerId:string,notification:object) { this.#send({type:'notify',id:workerId,notification}); }
  respond(workerId:string, id:string, response:{result?:unknown;error?:unknown}) {
    this.#send({type:'response',id:workerId,requestId:id,response});
  }
  rejectReply(id: string, message: string, workerId = id) { this.#send({type:'reject',id:workerId,callId:id,message}); }
  stop(id: string) { this.#send({type: 'stop', id}); }

  close(): Promise<void> {
    if (!this.#closing) {
      this.#closing = true;
      this.emit('closing');
      if (this.#host.connected) this.#host.send({type: 'close'}, () => {});
    }
    return this.#closed;
  }
}
