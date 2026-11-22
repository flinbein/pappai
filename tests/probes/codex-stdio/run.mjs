// Linux integration probe. Start one fresh container per mode (see README.md).
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
assert.ok(['online', 'offline', 'denied', 'codex-eof', 'codex-kill'].includes(mode));
const codex = process.env.PAPPAI_CODEX_NATIVE;
assert.equal(execFileSync(codex, ['--version'], { encoding: 'utf8' }).trim(), 'codex-cli 0.170.0');
const root = mkdtempSync('/var/tmp/stdio-probe-');
const output = root + '/output';
const read = path => readFileSync(path, 'utf8');
for (const directory of ['home', 'private', 'output']) mkdirSync(root + '/' + directory);
writeFileSync(root + '/input', 'readable');
writeFileSync(root + '/neighbor', 'outside');
const endpoint = createServer((_req, res) => res.end('isolated-loopback'));
await new Promise(resolve => endpoint.listen(0, '127.0.0.1', resolve));
const port = endpoint.address().port;
const wrapper = fileURLToPath(new URL('wrapper.mjs', import.meta.url));
const server = spawn(codex, ['app-server', '--stdio'], {
  cwd: root, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: root + '/home', CODEX_HOME: root + '/home',
    FIXTURE_OUTER_ONLY: 'sentinel' }, stdio: 'pipe',
});
let stderr = '', seq = 0;
const pending = new Map();
server.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-4096); });
server.stdin.on('error', () => {});
createInterface({ input: server.stdout }).on('line', line => {
  const msg = JSON.parse(line);
  const reply = pending.get(msg.id);
  if (reply) { pending.delete(msg.id); msg.error ? reply.reject(Error(JSON.stringify(msg.error))) : reply.resolve(msg.result); }
});
const closed = new Promise(resolve => server.once('close', (code, signal) => {
  for (const { reject } of pending.values()) reject(Error('app-server exited: ' + stderr));
  pending.clear();
  resolve({ code, signal });
}));
function request(method, params) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error(method + ' timed out: ' + stderr)); }, 20000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: err => { clearTimeout(timer); reject(err); } });
    server.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
async function waitFor(test, label) {
  for (let i = 0; i < 120; i++) { if (test()) return; await delay(50); }
  throw Error('Timed out waiting for ' + label);
}
function running(pid) {
  try { return !/^State:\s+[ZX]/m.test(read('/proc/' + pid + '/status')); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
const records = () => read(root + '/status').trim().split('\n').map(line => JSON.parse(line));
try {
  await request('initialize', { clientInfo: { name: 'pappai_stdio_probe', version: '1' }, capabilities: { experimentalApi: true } });
  server.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  const { thread } = await request('thread/start', {
    cwd: root, ephemeral: true, approvalPolicy: 'never',
    config: { mcp_servers: { scoped: { command: process.execPath, args: [wrapper, root, mode, String(port)],
      env_vars: ['FIXTURE_OUTER_ONLY'], env: { PAPPAI_TEMP_ROOT: root + '/private' }, startup_timeout_sec: 3 } } },
  });
  const { data } = await request('mcpServerStatus/list', { threadId: thread.id, serverName: 'scoped' });
  const nameList = Object.keys(data.find(item => item.name === 'scoped')?.tools ?? {});
  const { wrapper: wrapperPid, bwrap: bwrapPid, outerEnv } = records()[0];
  assert.equal(outerEnv, true);
  if (mode === 'denied') {
    assert.deepEqual(nameList, []);
    await assert.rejects(request('mcpServer/tool/call', { threadId: thread.id, server: 'scoped', tool: 'inspect', arguments: {} }));
    await waitFor(() => records().some(r => r.code > 0), 'bwrap setup error');
    assert.equal(existsSync(output + '/launched'), false);
    console.log(JSON.stringify({ mode, nameList, status: records(), workloadStarted: false }));
  } else {
    assert.deepEqual(nameList, ['inspect']);
    const call = await request('mcpServer/tool/call', { threadId: thread.id, server: 'scoped', tool: 'inspect', arguments: {} });
    const report = JSON.parse(call.content[0].text);
    assert.deepEqual(report, { input: 'readable', absent: 'ENOENT', readOnly: 'EROFS',
      network: mode === 'online' ? 'isolated-loopback' : 'ECONNREFUSED', allowed: 'yes',
      hasOuter: false, hasCodexHome: false, pid: 1, workerPid: report.workerPid });
    assert.ok(report.workerPid > 1);
    assert.equal(read(output + '/result'), 'written');
    assert.equal(read(root + '/input'), 'readable');
    const mcpPid = records().find(r => r['child-pid'])['child-pid'];
    const childPids = read('/proc/' + mcpPid + '/task/' + mcpPid + '/children').trim().split(/\s+/).map(Number);
    assert.equal(childPids.length, 1);
    const workerPid = childPids[0];
    const tracked = [wrapperPid, bwrapPid, mcpPid, workerPid];
    assert.equal(new Set(tracked).size, 4);
    assert.ok(tracked.every(pid => pid > 1 && running(pid)));
    const actions = { online: 'MCP SIGTERM', offline: 'wrapper SIGKILL', 'codex-eof': 'app-server stdin EOF', 'codex-kill': 'app-server SIGKILL' };
    if (mode === 'online') process.kill(mcpPid, 'SIGTERM');
    if (mode === 'offline') process.kill(wrapperPid, 'SIGKILL');
    if (mode === 'codex-kill') server.kill('SIGKILL');
    if (mode === 'codex-eof') server.stdin.end();
    await waitFor(() => tracked.every(pid => !running(pid)), 'wrapper, bwrap, MCP and ordinary child to stop');
    let codexExit;
    if (mode.startsWith('codex-')) {
      await waitFor(() => server.exitCode !== null || server.signalCode !== null, 'app-server to exit');
      codexExit = await closed;
      assert.deepEqual(codexExit, mode === 'codex-kill' ? { code: null, signal: 'SIGKILL' } : { code: 0, signal: null });
    }
    if (mode === 'online') assert.equal(read(output + '/graceful'), 'TERM');
    if (mode === 'offline') assert.equal(existsSync(output + '/graceful'), false);
    console.log(JSON.stringify({ mode, protocol: read(output + '/protocol'), nameList, report, outerEnv,
      stop: actions[mode], codexExit, graceful: existsSync(output + '/graceful') ? read(output + '/graceful') : null, liveAfter: 0 }));
  }
} finally {
  server.stdin.end();
  const timer = setTimeout(() => server.kill('SIGKILL'), 3000);
  await closed;
  clearTimeout(timer);
  endpoint.close();
  rmSync(root, { recursive: true, force: true });
}
