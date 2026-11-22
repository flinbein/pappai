// Run inside an offline Linux container. The two stages can run in distinct
// containers if the directory supplied as the last argument persists.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const [cli, stage, root] = process.argv.slice(2);
assert.ok(cli && ['create','restore'].includes(stage) && root);
const names = ['a', 'b'];
const token = 'fixture-shared-profile-only';
const marker = name => 'PRIVATE-HISTORY-' + name.toUpperCase();
const profiles = join(root, 'profiles');
const profile = join(profiles, 'shared-auth.json');
const state = join(root, 'threads.json');
const requests = [];
const http = createServer(async (req, res) => {
  if (req.url !== '/v1/responses' || req.headers.authorization !== 'Bearer ' + token) {
    res.writeHead(401).end();
    return;
  }
  const body = [];
  for await (const chunk of req) body.push(chunk);
  const input = JSON.parse(Buffer.concat(body)).input;
  requests.push(JSON.stringify(input));
  const id = 'resp_' + requests.length;
  const item = {type:'message', id:'msg_' + requests.length, role:'assistant', status:'completed',
    content:[{type:'output_text', text:'Fixture acknowledged.', annotations:[]}]};
  const events = [{type:'response.created',response:{id}}, {type:'response.output_item.done',output_index:0,item},
    {type:'response.completed',response:{id,usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}];
  res.writeHead(200, {'content-type':'text/event-stream'});
  res.end(events.map(e => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join(''));
});
http.listen(0, '127.0.0.1');
await once(http, 'listening');

async function session(name, ids) {
  const home = join(root, name);
  if (stage === 'create') {
    await mkdir(home);
    await symlink(profile, join(home, 'auth.json'));
  }
  const config = ['model="gpt-5.4"', 'model_provider="fixture"', 'cli_auth_credentials_store="file"',
    '[model_providers.fixture]', 'name="fixture"', 'wire_api="responses"', 'requires_openai_auth=true',
    'supports_websockets=false', 'base_url="http://127.0.0.1:' + http.address().port + '/v1"'];
  await writeFile(join(home,'config.toml'), config.join('\n'));
  const child = spawn(cli, ['app-server','--listen','stdio://'], {cwd:home,
    env:{HOME:home,CODEX_HOME:home,PATH:'/usr/bin:/bin'}, stdio:['pipe','pipe','inherit']});
  const exited = once(child,'close');
  const stream = createInterface({input:child.stdout})[Symbol.asyncIterator]();
  const deadline = setTimeout(() => child.kill('SIGKILL'), 30000);
  const send = msg => child.stdin.write(JSON.stringify(msg) + '\n');
  let serial = 0;
  const completed = new Map();
  async function until(predicate) {
    for (;;) {
      const line = await stream.next();
      if (line.done) throw Error('app-server closed while waiting for a message');
      const msg = JSON.parse(line.value);
      if (msg.method === 'turn/completed') completed.set(msg.params.turn.id, msg.params.turn);
      if (predicate(msg)) return msg;
    }
  }
  async function rpc(method,params) {
    const id = ++serial;
    send({id,method,params});
    const {error,result} = await until(msg => msg.id === id && !msg.method);
    if (error) throw Error(method + ': ' + error.message);
    return result;
  }
  try {
    const init = await rpc('initialize',{clientInfo:{name:'history_fixture',version:'1'},capabilities:{}});
    assert.match(init.userAgent,/\/0\.170\.0\b/);
    send({method:'initialized'});
    assert.equal((await rpc('account/read',{})).account.type,'apiKey');
    let id;
    if (stage === 'create') {
      id = (await rpc('thread/start',{cwd:home,approvalPolicy:'never',sandbox:'read-only'})).thread.id;
    } else {
      id = ids[name];
      const other = names.find(n => n !== name);
      const listed = await rpc('thread/list',{});
      assert.deepEqual(listed.data.map(thread => thread.id), [id]);
      await assert.rejects(rpc('thread/resume',{threadId:ids[other]}), /not found|unable to find|no rollout/i);
      const restored = await rpc('thread/resume',{threadId:id});
      const history = JSON.stringify(restored.thread.turns);
      assert.ok(history.includes(marker(name)) && history.includes('Fixture acknowledged.'));
      assert.ok(!history.includes(marker(other)));
    }
    const text = stage === 'create' ? marker(name) : 'Continue the previous turn.';
    const {turn} = await rpc('turn/start',{threadId:id,input:[{type:'text',text}]});
    if (!completed.has(turn.id)) await until(() => completed.has(turn.id));
    assert.equal(completed.get(turn.id).status, 'completed');
    return id;
  } finally {
    child.stdin.end();
    try { assert.equal((await exited)[0],0); } finally { clearTimeout(deadline); }
  }
}

try {
  let ids = {};
  if (stage === 'create') {
    await mkdir(profiles,{recursive:true});
    await writeFile(profile,JSON.stringify({OPENAI_API_KEY:token}),{flag:'wx',mode:0o600});
  } else {
    ids = JSON.parse(await readFile(state,'utf8'));
  }
  const result = await Promise.all(names.map(name => session(name, ids)));
  assert.notEqual(result[0],result[1]);
  assert.equal(requests.length, 2);
  for (const name of names) {
    const own = requests.filter(input => input.includes(marker(name)));
    assert.equal(own.length,1);
    assert.ok(!own[0].includes(marker(names.find(n => n !== name))));
  }
  if (stage === 'create') await writeFile(state, JSON.stringify(Object.fromEntries(names.map((n,i) => [n,result[i]]))));
  console.log(JSON.stringify({stage,threads:result,authenticatedMockTurns:requests.length}));
} finally {
  http.closeAllConnections();
  http.close();
}
