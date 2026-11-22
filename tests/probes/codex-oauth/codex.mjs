import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

const executable = process.argv[2] ?? 'codex';

export async function config(home, servers) {
  await fs.mkdir(home, { recursive: true });
  const lines = [
    'mcp_oauth_credentials_store = "file"', 'cli_auth_credentials_store = "file"',
    'model_provider = "fixture"', 'model = "fixture"', 'check_for_update_on_startup = false',
    '[model_providers.fixture]', 'name = "Fixture"', 'base_url = "http://127.0.0.1:1/v1"', 'wire_api = "responses"',
    '[analytics]', 'enabled = false', '[feedback]', 'enabled = false',
    '[features]', 'apps = false'
  ];
  for (const [name, { url, bearer }] of Object.entries(servers)) {
    lines.push('[mcp_servers.' + name + ']', 'url = ' + JSON.stringify(url), 'default_tools_approval_mode = "approve"');
    if (bearer) {
      lines.push('bearer_token_env_var = "FIXTURE_PROFILE_ACCESS"');
    } else {
      lines.push('[mcp_servers.' + name + '.oauth]', 'client_id = "fixture"', 'client_secret = "fixture-secret"',
        'callback_url = "http://127.0.0.1:32123/callback"');
    }
  }
  await fs.writeFile(path.join(home, 'config.toml'), lines.join('\n') + '\n');
}

function run(home, args, bearer) {
  const env = {};
  for (const name of ['PATH', 'SystemRoot', 'ComSpec', 'PATHEXT', 'LD_LIBRARY_PATH']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  Object.assign(env, { CODEX_HOME: home, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home, TEMP: home, TMP: home, TMPDIR: home });
  if (bearer) env.FIXTURE_PROFILE_ACCESS = bearer;
  const child = spawn(executable, args, { env, cwd: home, windowsHide: true });
  child.stdin.on('error', () => {});
  child.stderr.resume();
  return child;
}

export async function login(home, name, account, provider) {
  const child = run(home, ['mcp', 'login', name, '--no-browser']);
  const exit = new Promise((resolve, reject) => {
    child.once('close', resolve);
    child.once('error', reject);
  });
  const timer = setTimeout(() => child.kill(), 20000);
  try {
    for await (const line of readline.createInterface({ input: child.stdout })) {
      const match = line.match(/https?:\/\/\S+/);
      if (!match) continue;
      const loginUrl = new URL(match[0]);
      if (!loginUrl.searchParams.has('state')) continue;
      assert.equal(loginUrl.origin, provider.origin);
      loginUrl.searchParams.set('account', account);
      const result = await fetch(loginUrl, { redirect: 'manual' });
      assert.equal(result.status, 302);
      child.stdin.write(result.headers.get('location') + '\n');
    }
    assert.equal(await exit, 0, 'native OAuth login failed: ' + name);
  } finally { clearTimeout(timer); child.kill(); }
}

export async function ageGrant(home) {
  const file = path.join(home, '.credentials.json');
  const store = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(Object.keys(store).length, 1, 'fixture expects a single native grant per home');
  for (const grant of Object.values(store)) grant.expires_at = 0;
  await fs.writeFile(file, JSON.stringify(store), { mode: 0o600 });
}

export async function executor(home, bearer) {
  const child = run(home, ['app-server', '--stdio', '--strict-config'], bearer);
  const pending = new Map();
  let serial = 0;
  const exit = new Promise(resolve => child.once('close', resolve));
  const send = obj => child.stdin.write(JSON.stringify(obj) + '\n');
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    if (message.method) {
      send({ id: message.id, error: { code: -32000, message: 'Fixture rejects interactive requests' } });
      return;
    }
    const request = pending.get(message.id);
    if (request) {
      pending.delete(message.id);
      if (message.error) request.reject(Error(request.method + ': ' + message.error.message));
      else request.resolve(message.result);
    }
  });
  function fail(error) {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  }
  child.once('error', fail);
  exit.then(code => fail(Error('app-server exited: ' + code)));
  function request(method, params) {
    const id = ++serial;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('RPC timeout: ' + method)), 25000);
      pending.set(id, { method, resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); } });
    });
    send({ id, method, params });
    return result;
  }
  async function close() { child.kill(); await exit; }
  try {
    await request('initialize', { clientInfo: { name: 'pappai_probe', version: '1' }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized', params: {} });
    const { thread } = await request('thread/start', { cwd: home, ephemeral: true, approvalPolicy: 'never' });
    const status = (await request('mcpServerStatus/list', { threadId: thread.id })).data;
    return {
      status, close,
      async call(server) {
        const result = await request('mcpServer/tool/call', { threadId: thread.id, server, tool: 'whoami', arguments: {} });
        assert.ok(!result.isError, 'tool call failed on ' + server);
        return result.content[0].text;
      }
    };
  } catch (error) { await close(); throw error; }
}
