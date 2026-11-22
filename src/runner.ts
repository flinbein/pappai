import { fork, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

export type Sandbox = {read: string[]; write: string[]; network: boolean} | null;
export type InputRecord = {from:string; method?:string; event?:string; id?:string; data?:unknown; subscription?:string};
export type RunnerSettings = Record<string,unknown> & {env?: Record<string,string>};
export type ProcessSettings = RunnerSettings & {cwd:string;command:string;args?:string[]};
export type Assignment<Settings extends RunnerSettings = RunnerSettings> = {
  appId: string; id: string; from: string; method?: string; event?:string; data: unknown; subscription?:string;
  settings: Settings;
  sandbox: Sandbox; maxLifetimeMs?: number; mode?: 'oneShot'|'persistent'; runnerType?:string;
  holdFirst?: boolean;
  runtimeMounts?:Array<{source:string;target:string;readonly:boolean}>;
};
export class ProcessRunner extends EventEmitter {
  #host: ChildProcess;
  #closed: Promise<void>;
  #closing = false;
  #lost = false;

  constructor(entrypoint = new URL('./runner-host.ts', import.meta.url)) {
    super();
    this.#host = fork(entrypoint, [], {
      execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    this.#closed = new Promise(resolve => this.#host.once('close', () => resolve()));
    this.#host.on('message', (msg: any) => {
      if (['reply','exit','started','written','request'].includes(msg?.type)) this.emit(msg.type, msg.payload);
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
      if (this.#host.connected) this.#host.send({type: 'close'}, () => {});
    }
    return this.#closed;
  }
}
