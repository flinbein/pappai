import { fork, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

export type Sandbox = {read: string[]; write: string[]; network: boolean} | null;
export type Assignment = {
  appId: string; id: string; from: string; method: string; data: unknown;
  settings: {cwd: string; command: string; args?: string[]; env?: Record<string, string>};
  sandbox: Sandbox; maxLifetimeMs?: number;
};

export class ProcessRunner extends EventEmitter {
  #host: ChildProcess;
  #closed: Promise<void>;
  #closing = false;
  #lost = false;

  constructor() {
    super();
    this.#host = fork(new URL('./runner-host.ts', import.meta.url), [], {
      execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    this.#closed = new Promise(resolve => this.#host.once('close', () => resolve()));
    this.#host.on('message', (msg: any) => {
      if (msg.type === 'reply' || msg.type === 'exit' || msg.type === 'started') {
        this.emit(msg.type, msg.payload);
      }
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
  rejectReply(id: string, message: string) { this.#send({type: 'reject', id, message}); }
  stop(id: string) { this.#send({type: 'stop', id}); }

  close(): Promise<void> {
    if (!this.#closing) {
      this.#closing = true;
      if (this.#host.connected) this.#host.send({type: 'close'}, () => {});
    }
    return this.#closed;
  }
}
