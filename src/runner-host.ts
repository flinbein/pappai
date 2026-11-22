import { spawn, type ChildProcess } from 'node:child_process';
import { Writable, Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import type { Assignment, InputRecord, ProcessSettings } from './runner.ts';
import { sandboxArgs } from './sandbox.ts';

type Worker = {
  appId: string; id: string; child: ChildProcess; executablePid?: number;
  issue?: string; startFailed?: boolean; stopped?: boolean;
  deadline?: NodeJS.Timeout; killTimer?: NodeJS.Timeout;
  persistent: boolean; holdFirst:boolean; requests: Set<string>;
};

const workers = new Map<string, Worker>();
let closing = false;
// The application result is limited to 1 MiB, with room for JSONL framing.
const maxLine = 1024 * 1024 + 2048;

function emit(type: string, payload: object) {
  if (process.connected) process.send?.({type, payload}, () => {});
}

function signal(worker: Worker, value: NodeJS.Signals) {
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
  try {
    if (worker.executablePid && worker.child.pid !== worker.executablePid) {
      // This is the host-visible PID of PID 1 in the private namespace.
      process.kill(worker.executablePid, value);
    } else {
      worker.child.kill(value);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      worker.issue ??= 'could not signal executor';
    }
  }
}

function stop(worker: Worker) {
  if (worker.stopped) return;
  worker.stopped = true;
  signal(worker, 'SIGINT');
  worker.killTimer = setTimeout(() => {
    signal(worker, 'SIGKILL');
    worker.killTimer = setTimeout(() => {
      if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
      // Revoke the protocol even if the OS still holds the process.
      workers.delete(worker.id);
      clearTimeout(worker.deadline);
      for (const pipe of worker.child.stdio) pipe?.destroy();
      worker.child.unref();
      emit('exit', {id: worker.id, appId: worker.appId, stopFailed: true,
        issue: 'Executor exit after SIGKILL could not be confirmed'});
      closeIfIdle();
    }, 1000);
  }, 10000);
}

function closeIfIdle() {
  if (closing && !workers.size && process.connected) process.disconnect();
}

function write(worker:Worker, record:object, onWritten?:()=>void) {
  const line = JSON.stringify(record) + '\n';
  const pipe = worker.child.stdin!;
  if (!pipe.writable || pipe.writableLength > 2 * maxLine || Buffer.byteLength(line) > maxLine) {
    worker.issue ??= 'Executor stdin unavailable or full';
    stop(worker);
    return;
  }
  pipe.write(line, err => {
    if (!err) return onWritten?.();
    worker.issue ??= 'Executor stdin closed';
    stop(worker);
  });
}

function deliver(worker:Worker, item:InputRecord) {
  const {from,method,event,id,data,subscription} = item;
  write(worker, {from,...(method ? {id,method} : {event,subscription}),data}, () =>
    emit('written',{appId:worker.appId,workerId:worker.id,id}));
}

function readReplies(worker: Worker) {
  let buffered: Buffer = Buffer.alloc(0);
  const stream = worker.child.stdout!;
  function invalid(issue: string) {
    worker.issue ??= issue;
    stream.destroy();
    stop(worker);
  }
  stream.on('data', (part: Buffer) => {
    const data = buffered.length ? Buffer.concat([buffered, part]) : part;
    let start = 0;
    for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
      if (end - start > maxLine) return invalid('executor reply too large');
      let msg;
      try { msg = JSON.parse(data.toString('utf8', start, end)); }
      catch { return invalid('invalid JSONL reply'); }
      if (!msg || typeof msg.id !== 'string' || !msg.id || msg.id.length > 255)
        return invalid('invalid reply or request id');
      if (typeof msg.method === 'string' && !('result' in msg) && !('error' in msg)) {
        if (worker.requests.size >= 32 || worker.requests.has(msg.id))
          return invalid('too many pending requests or duplicate id');
        worker.requests.add(msg.id);
        emit('request',{appId:worker.appId,workerId:worker.id,id:msg.id,method:msg.method,params:msg.params});
      } else {
        if ((!worker.persistent && msg.id !== worker.id) ||
            Object.hasOwn(msg,'result') === Object.hasOwn(msg,'error')) return invalid('invalid reply or call id');
        const payload = {appId:worker.appId,id:msg.id,...(worker.persistent && {workerId:worker.id})};
        emit('reply', 'result' in msg ? {...payload,result:msg.result} : {...payload,error:msg.error});
      }
      start = end + 1;
    }
    buffered = data.subarray(start);
    if (buffered.length > maxLine) invalid('executor reply too large');
  });
  stream.on('end', () => {
    if (buffered.length) worker.issue ??= 'unterminated executor reply';
  });
}

function dispatch(job: Assignment<ProcessSettings>) {
  const {appId, id, settings} = job;
  if (closing || workers.has(id)) throw new Error('runner cannot accept assignment');
  let child: ChildProcess;
  let options: string[] | undefined;
  if (job.sandbox === null) {
    const env = {PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...settings.env};
    child = spawn(settings.command, settings.args ?? [], {cwd: settings.cwd, env, stdio: 'pipe', windowsHide: true});
  } else {
    options = sandboxArgs(job);
    child = spawn('/usr/bin/bwrap', ['--args', '3', '--', settings.command, ...(settings.args ?? [])], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'], env: {PATH: '/usr/bin:/bin'},
    });
  }
  const worker: Worker = {appId, id, child, persistent:job.mode === 'persistent',holdFirst:job.holdFirst === true,requests:new Set()};
  workers.set(id, worker);
  child.on('error', error => {
    worker.issue ??= error.message;
    if (!child.pid) worker.startFailed = true;
  });
  let sandboxReportedExit = false;
  if (options) {
    // Keep the workload's environment off the command line and out of the
    // privileged bwrap process's environment. bwrap reads these from a private fd.
    const configuration = child.stdio[3] as Writable;
    configuration.on('error', () => {});
    configuration.end(Buffer.from(options.join('\0') + '\0'));
    const status = createInterface({input: child.stdio[4] as Readable});
    status.on('line', (line: string) => {
      try {
        // bwrap writes an exit-code record only after the executable started.
        const record = JSON.parse(line);
        if (Number.isInteger(record['exit-code'])) sandboxReportedExit = true;
        const pid = record['child-pid'];
        if (Number.isSafeInteger(pid) && pid > 1) worker.executablePid = pid;
      } catch { worker.issue ??= 'invalid sandbox status'; }
    });
  }
  let diagnostic = '';
  child.stderr!.on('data', (bytes: Buffer) => {
    diagnostic = (diagnostic + bytes.toString('utf8')).slice(-2048);
  });
  readReplies(worker);
  child.stdin!.on('error', () => {}); // A child can exit before the first write.
  child.once('spawn', () => {
    emit('started', {id, appId});
    if (!worker.holdFirst && !worker.stopped) deliver(worker,job);
    if (job.maxLifetimeMs) worker.deadline = setTimeout(() => {
      worker.issue ??= 'executor lifetime exceeded';
      stop(worker);
    }, job.maxLifetimeMs);
  });
  child.once('exit', () => {
    // Trusted, unsandboxed descendants may inherit pipes and keep them open.
    // The worker slot belongs to the main process; allow its buffered reply to drain.
    const drain = setTimeout(() => {
      child.stdout!.destroy(); child.stderr!.destroy();
    }, 200);
    drain.unref();
    child.once('close', () => clearTimeout(drain));
  });
  child.once('close', (code, signame) => {
    if (!workers.has(id)) return;
    clearTimeout(worker.deadline);
    clearTimeout(worker.killTimer);
    workers.delete(id);
    if (code !== 0) {
      if (options && !sandboxReportedExit && !worker.stopped) worker.startFailed = true;
      worker.issue ??= 'executor exited: ' + (signame ?? code);
      if (diagnostic) process.stderr.write(`[process ${appId}] ${diagnostic}\n`);
    }
    emit('exit', {appId, id, ...(worker.issue && {issue: worker.issue}),
      ...(worker.startFailed && {startFailed: true})});
    closeIfIdle();
  });
}

function close() {
  closing = true;
  for (const worker of workers.values()) stop(worker);
  closeIfIdle();
}
process.on('message', (msg: any) => {
  if (msg.type === 'dispatch') {
    try { dispatch(msg.job); }
    catch (error) {
      emit('exit', {appId: msg.job.appId, id: msg.job.id, issue: (error as Error).message, startFailed: true});
    }
  } else if (msg.type === 'close') close();
  else {
    const worker = workers.get(msg.id);
    if (!worker) return;
    if (msg.type === 'stop') stop(worker);
    if (msg.type === 'reject') write(worker,{id:msg.callId,error:{message:msg.message}});
    if (msg.type === 'notify') write(worker,msg.notification);
    if (msg.type === 'deliver' && (worker.persistent || worker.holdFirst) && !worker.stopped) {
      worker.holdFirst = false;
      deliver(worker,msg.item);
    }
    if (msg.type === 'response' && worker.requests.delete(msg.requestId))
      write(worker,{id:msg.requestId,...msg.response});
  }
});
process.on('disconnect', close);
