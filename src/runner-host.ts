import { spawn, type ChildProcess } from 'node:child_process';
import { Writable, Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import type { Assignment } from './runner.ts';
import { sandboxArgs } from './sandbox.ts';

type Worker = {
  appId: string; id: string; child: ChildProcess; executablePid?: number;
  issue?: string; startFailed?: boolean; stopped?: boolean;
  deadline?: NodeJS.Timeout; killTimer?: NodeJS.Timeout;
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
      if (!msg || msg.id !== worker.id ||
          Object.hasOwn(msg, 'result') === Object.hasOwn(msg, 'error')) {
        return invalid('invalid reply or call id');
      }
      const payload = {appId: worker.appId, id: worker.id};
      emit('reply', 'result' in msg ? {...payload, result: msg.result} : {...payload, error: msg.error});
      start = end + 1;
    }
    buffered = data.subarray(start);
    if (buffered.length > maxLine) invalid('executor reply too large');
  });
  stream.on('end', () => {
    if (buffered.length) worker.issue ??= 'unterminated executor reply';
  });
}

function dispatch(job: Assignment) {
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
  const worker: Worker = {appId, id, child};
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
    child.stdin!.write(JSON.stringify({from: job.from, id, method: job.method, data: job.data}) + '\n');
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
    if (msg.type === 'reject' && worker.child.stdin?.writable) {
      worker.child.stdin.write(JSON.stringify({id: msg.id, error: {message: msg.message}}) + '\n');
    }
  }
});
process.on('disconnect', close);
