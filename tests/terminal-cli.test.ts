import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
import { Store } from '../src/store.ts';
import { FileDelegations } from '../src/file-delegations.ts';
import { attachTerminals, type TerminalView } from '../src/terminal.ts';

test('Linux terminal CLI authenticates calls and relays sandboxed actions in the caller PTY',
  {skip: process.env.PAPPAI_TEST_BWRAP !== '1', timeout: 30000}, async () => {
  const db = new DatabaseSync(':memory:');
  const store = new Store(db);
  const files = new FileDelegations(store);
  const actor = store.create('~','user',{name:'Terminal',email:'test@example.org',permissions:null}).id;
  store.setStatus(actor,'working');
  const dir = mkdtempSync('/run/terminal-cli-test-');
  const workspace = mkdtempSync('/var/terminal-workspace-');
  const dataDir = workspace + '/data';
  const editable = dataDir + '/editable';
  mkdirSync(editable,{recursive:true});
  writeFileSync(dataDir + '/visible','original');
  const worker = store.create('~','user',{name:'File operator',email:'files@example.org',
    permissions:[{write:editable},{read:dataDir}]}).id;
  store.setStatus(worker,'working');
  const script = dir + '/script';
  writeFileSync(script, [
    'test -n "$PAPPAI_CLI_TMP" && test ! -r ' + dir + '/secret || exit 91',
    'test "$ACTION_ENV" = "two words" || exit 92',
    'test -t 0 || exit 93',
    'test ! -e /run/pappai-admin/rpc.sock && test -z "${PAPPAI_TERMINAL_TOKEN+x}${PAPPAI_TERMINAL_SOCKET+x}" || exit 90',
    'pappai -u other me >/dev/null 2>&1 && exit 95',
    'pappai call other import >/dev/null 2>&1 && exit 96',
    'pappai cli profile args >/dev/null 2>&1 && exit 97',
    'printf private > "$PAPPAI_CLI_TMP/file"',
    'cd "$PAPPAI_CLI_TMP" || exit 80',
    `pappai --with-rpc run /bin/sh -ec '` + [
      'test -f file && test -z "${PAPPAI_CLI_TMP+x}${ACTION_ENV+x}"',
      'test ! -e /run/pappai/cli/0 && test ! -e /run/pappai-admin',
      'pappai -u other me >/dev/null 2>&1 && exit 82',
      'pappai discover >/dev/null 2>&1 && exit 83',
      'pappai call other import >/dev/null 2>&1 && exit 84',
      'pappai cli profile args >/dev/null 2>&1 && exit 85',
      'printf child > /tmp/run-data',
      'pappai call profile import "{\\"cwd\\":\\"$PWD/file\\",\\"tmp\\":\\"/tmp/run-data\\"}"',
      'pappai run /bin/sh -c "test ! -e /tmp/run-data && test -f file && test ! -S /run/pappai/terminal.sock"',
    ].join('\n') + "' </dev/null || exit 86",
    'test ! -e /tmp/run-data || exit 87',
    'pappai call profile import "{}" || exit 94',
    'printf "ready\\n"',
    'read -r value',
    'printf "[%s] " "$value"',
    'stty size',
    'exit 7',
  ].join('\n'));
  writeFileSync(dir + '/secret','outside');
  symlinkSync(script,dir+'/link');
  const server = createServer().listen(0,'127.0.0.1');
  await once(server,'listening');
  const origin = new URL('http://127.0.0.1:' + server.address().port);
  let valid = true;
  let view: TerminalView | undefined;
  let rpcCalls = 0;
  let enter!: () => void;
  let aborted!: () => void;
  const preparing = new Promise<void>(resolve => { enter = resolve; });
  const cancelled = new Promise<void>(resolve => { aborted = resolve; });
  const terminals = attachTerminals(server,origin,store,req => valid ?
    (req.headers.cookie === 'ok' ? actor : req.headers.cookie === 'worker' ? worker : null) : null,{
    async rpc(user, method, params, current) {
      assert.equal(user,actor);
      rpcCalls++;
      if (params.method === 'import') {
        if (params.data?.cwd) {
          assert.equal(files.readProfileFile(user,params.data.cwd,undefined,current).toString(),'private');
          assert.equal(files.readProfileFile(user,params.data.tmp,undefined,current).toString(),'child');
          return {child:true};
        }
        view = current;
        assert.equal(readFileSync(view.scratch!.source + '/file','utf8'),'private');
        return {imported:true};
      }
      return {method,params,mounted:!!current.sandbox};
    },
    async prepareCli(user, node, method, input, signal) {
      assert.equal(user,actor);
      assert.equal(node,'profile');
      if (method === 'wait') {
        enter();
        return new Promise((_,reject) => signal.addEventListener('abort',()=>{
          aborted();
          reject(Error('Cancelled'));
        },{once:true}));
      }
      if (method === 'bad') return {files:[dir+'/link'],argv:['true']};
      if (method === 'args') {
        assert.deepEqual(input,{args:['one two','$HOME','']});
        return {files:[],argv:['/bin/sh','-c','test ! -e /run/pappai/terminal.sock && test ! -e /run/pappai-admin && printf args-id:ok']};
      }
      assert.deepEqual(input,{});
      return {files:[script],argv:['/bin/sh','/run/pappai/cli/0'],env:{ACTION_ENV:'two words'},node,calls:['import']};
    },
  });
  async function open(request: object, force=false, onOutput?: (text: string, ws: WebSocket)=>void, cookie='ok') {
    const ws = new WebSocket('ws://'+origin.host+'/api/ws/terminal?start=manual'+(force?'&sandbox=1':''),{
      headers:{origin:origin.origin,cookie},
    });
    let output = '';
    const statuses: any[] = [];
    ws.on('message',(raw,binary)=>{
      if (binary) {
        output += raw.toString();
        ws.send(JSON.stringify({rendered:raw.length}));
        onOutput?.(output,ws);
      } else statuses.push(JSON.parse(raw.toString()));
    });
    const closed = once(ws,'close').then(([code])=>({output,statuses,code}));
    await once(ws,'open');
    ws.send(JSON.stringify(request));
    return {ws,closed};
  }
  try {
    const grants = await (await open({argv:['pappai','run','/bin/sh','-ec',
      'test "$(cat "$1/visible")" = original && echo updated > "$1/editable/result"', 'test',dataDir]},
      false,undefined,'worker')).closed;
    assert.deepEqual(grants.statuses.at(-1),{exitCode:0},JSON.stringify(grants));
    assert.equal(readFileSync(editable+'/result','utf8').trim(),'updated');
    let renamed = false;
    const changed = await (await open({argv:['/bin/sh','-ec',[
      'echo ready-to-rename',
      'read -r command',
      'if pappai run /bin/true; then exit 1; fi',
      'test "$(cat "$1/visible")" = original',
    ].join('\n'),'test',dataDir]},false,(output,ws)=>{
      if (!renamed && output.includes('ready-to-rename')) {
        renamed = true;
        renameSync(dataDir,workspace+'/previous');
        mkdirSync(editable,{recursive:true});
        ws.send(Buffer.from('continue\r'));
      }
    },'worker')).closed;
    assert.deepEqual(changed.statuses.at(-1),{exitCode:0},JSON.stringify(changed));
    assert.match(changed.output,/mount source changed/i);
    store.manage(actor,worker,'$.permissions.set',{permissions:[{read:editable,deny:true},{write:dataDir}]});
    const unstable = await (await open({argv:['/bin/true']},false,undefined,'worker')).closed;
    assert.equal(unstable.statuses[0]?.startFailed,true);
    assert.match(unstable.statuses[0].error,/nested mount below writable directory/);
    {
      const run = await (await open({argv:['/bin/sh','-c',[
        'pappai call target method "$INPUT"',
        'pappai help --schema --doc target feature',
        'pappai discover "{}"',
        'pappai emit hello 42',
      ].join(' && ')],env:{INPUT:'{"a":"x y"}'}},true)).closed;
      assert.equal(run.code,1000,JSON.stringify(run));
      const results = run.output.trim().split(/\r?\n/).map(line=>JSON.parse(line));
      assert.deepEqual(results.map(x=>x.method),['call','help','discover','publish']);
      assert.deepEqual(results[0],{method:'call',params:{node:'target',method:'method',data:{a:'x y'}},mounted:true});
      assert.deepEqual(results[1].params,{node:'target',features:'feature',doc:true,schema:true});
      assert.deepEqual(results[3].params,{event:'hello',data:42});
    }
    const raw = await (await open({argv:['pappai','cli','profile','args','--','one two','$HOME','']},true)).closed;
    assert.equal(raw.output,'args-id:ok');
    const cwd = await (await open({argv:['/bin/sh','-ec',[
      'dir=$(mktemp -d /tmp/work-XXXXXX)',
      'cd "$dir" && echo parent > input && touch /tmp/parent-only',
      `pappai run /bin/sh -ec '` + [
        'test -t 0 && test -t 1 && test "$(cat input)" = parent',
        'test "$PWD" = "$1" && test ! -e /tmp/parent-only',
        'test ! -e /run/pappai/terminal.sock && test ! -e /run/pappai-admin/rpc.sock',
        'test "$(readlink /proc/self/ns/net)" != "$2" && test ! -e /opt/pappai/src/pappai',
        'test -z "${SECRET+x}" && echo child > output && touch /tmp/child-only',
      ].join(' && ') + `' test "$PWD" "$HOST_NET"`,
      'test "$(cat output)" = child && test ! -e /tmp/child-only',
    ].join('\n')],env:{HOST_NET:readlinkSync('/proc/self/ns/net'),SECRET:'parent'}},true)).closed;
    assert.deepEqual(cwd.statuses.at(-1),{exitCode:0},JSON.stringify(cwd));
    for (const nested of [false,true]) {
      let inputSent = false;
      const request = nested ? {argv:['pappai','cli','profile','login','{}']} :
        {cli:{node:'profile',method:'login',input:{}}};
      const result = await (await open({...request,cols:90,rows:32},true,(text,ws)=>{
        if (!inputSent && text.includes('ready')) {
          inputSent = true;
          ws.send(JSON.stringify({cols:101,rows:39}));
          ws.send(Buffer.from('two words\r'));
        }
      })).closed;
      assert.equal(result.statuses[0]?.sandboxed,true,JSON.stringify(result));
      assert.match(result.output,/"imported": true/);
      assert.match(result.output,/\[two words\] 39 101/);
      assert.deepEqual(result.statuses.at(-1),{exitCode:7});
      assert.ok(view?.revoked);
      assert.equal(existsSync(view!.scratch!.source),false);
    }
    const invalid = await (await open({cli:{node:'profile',method:'bad',input:{}}})).closed;
    assert.equal(invalid.statuses[0]?.startFailed,true);
    const noOverride = await (await open({argv:['true'],env:{PAPPAI_TERMINAL_TOKEN:'x'}})).closed;
    assert.equal(noOverride.code,1008);

    assert.equal(rpcCalls,8);
    const subject = store.create('~','user',{name:'Run subject',email:'run@example.org',permissions:[]}).id;
    store.setStatus(subject,'working');
    const revoke = await (await open({argv:['pappai','-r',subject,'--with-rpc','run','/bin/sh','-ec',[
      'pappai me >/dev/null',
      'echo awaiting-revocation',
      'read -r command',
      'if pappai me || pappai run /bin/true; then exit 81; fi',
      'echo child-still-running',
    ].join('\n')]},true,(output,ws)=>{
      if (output.includes('awaiting-revocation') && store.get(subject)?.status === 'working') {
        store.setStatus(subject,'stopped');
        ws.send(Buffer.from('continue\r'));
      }
    })).closed;
    assert.deepEqual(revoke.statuses.at(-1),{exitCode:0},JSON.stringify(revoke));
    assert.match(revoke.output,/Permission denied[\s\S]*Permission denied[\s\S]*child-still-running/);
    const waiting = await open({cli:{node:'profile',method:'wait',input:{}}});
    await preparing;
    let running!: () => void;
    const started = new Promise<void>(resolve=>{ running=resolve; });
    const interrupted = await open({argv:['pappai','cli','profile','login']},true,
      text=>{ if (text.includes('ready')) running(); });
    await started;
    const activeView = view!;
    assert.ok(existsSync(activeView.scratch!.source + '/file'));
    const sibling = await (await open({argv:['/bin/sh','-c',
      'test ! -e "$SCRATCH/file" && test ! -e "$SOURCE/file" && test ! -e /run/pappai-admin'],
      env:{SCRATCH:activeView.scratch!.path,SOURCE:activeView.scratch!.source}},true)).closed;
    assert.deepEqual(sibling.statuses.at(-1),{exitCode:0});
    valid = false;
    terminals.checkSessions();
    await Promise.all([waiting.closed,cancelled,interrupted.closed]);
    await terminals.close();
    assert.equal(existsSync(activeView.scratch!.source),false);
    assert.ok(activeView.revoked);
  } finally {
    await terminals.close();
    await new Promise(resolve=>server.close(resolve));
    rmSync(dir,{recursive:true,force:true});
    rmSync(workspace,{recursive:true,force:true});
    db.close();
  }
});
