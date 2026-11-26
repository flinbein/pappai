import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
import { Store } from '../src/store.ts';
import { attachTerminals, type TerminalView } from '../src/terminal.ts';

test('Linux terminal CLI authenticates calls and relays sandboxed actions in the caller PTY',
  {skip: process.env.PAPPAI_TEST_BWRAP !== '1', timeout: 30000}, async () => {
  const db = new DatabaseSync(':memory:');
  const store = new Store(db);
  const actor = store.create('~','user',{name:'Terminal',email:'test@example.org',permissions:null}).id;
  store.setStatus(actor,'working');
  const dir = mkdtempSync('/run/terminal-cli-test-');
  const script = dir + '/script';
  writeFileSync(script, [
    'test -n "$PAPPAI_CLI_TMP" && test ! -r ' + dir + '/secret || exit 91',
    'test "$ACTION_ENV" = "two words" || exit 92',
    'test -t 0 || exit 93',
    'printf private > "$PAPPAI_CLI_TMP/file"',
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
  const terminals = attachTerminals(server,origin,store,req => valid && req.headers.cookie === 'ok' ? actor : null,{
    async rpc(user, method, params, current) {
      assert.equal(user,actor);
      rpcCalls++;
      if (params.method === 'import') {
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
        return {files:[],argv:['printf','args-id:%s','ok']};
      }
      assert.deepEqual(input,{});
      return {files:[script],argv:['/bin/sh','/run/pappai/cli/0'],env:{ACTION_ENV:'two words'}};
    },
  });
  async function open(request: object, force=false, onOutput?: (text: string, ws: WebSocket)=>void) {
    const ws = new WebSocket('ws://'+origin.host+'/api/ws/terminal?start=manual'+(force?'&sandbox=1':''),{
      headers:{origin:origin.origin,cookie:'ok'},
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
    for (const force of [false,true]) {
      const run = await (await open({argv:['/bin/sh','-c',[
        'pappai call target method "$INPUT"',
        'pappai help --schema --doc target feature',
        'pappai discover "{}"',
        'pappai emit hello 42',
      ].join(' && ')],env:{INPUT:'{"a":"x y"}'}},force)).closed;
      assert.equal(run.code,1000,JSON.stringify(run));
      const results = run.output.trim().split(/\r?\n/).map(line=>JSON.parse(line));
      assert.deepEqual(results.map(x=>x.method),['call','help','discover','publish']);
      assert.deepEqual(results[0],{method:'call',params:{node:'target',method:'method',data:{a:'x y'}},mounted:force});
      assert.deepEqual(results[1].params,{node:'target',features:'feature',doc:true,schema:true});
      assert.deepEqual(results[3].params,{event:'hello',data:42});
    }
    const raw = await (await open({argv:['pappai','cli','profile','args','--','one two','$HOME','']})).closed;
    assert.equal(raw.output,'args-id:ok');
    for (const nested of [false,true]) {
      let inputSent = false;
      const request = nested ? {argv:['pappai','cli','profile','login','{}']} :
        {cli:{node:'profile',method:'login',input:{}}};
      const result = await (await open({...request,cols:90,rows:32},false,(text,ws)=>{
        if (!inputSent && text.includes('ready')) {
          inputSent = true;
          ws.send(JSON.stringify({cols:101,rows:39}));
          ws.send(Buffer.from('two words\r'));
        }
      })).closed;
      assert.equal(result.statuses[0]?.sandboxed,!nested,JSON.stringify(result));
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

    let pathReady!: (path: string)=>void;
    const socketPath = new Promise<string>(resolve=>{ pathReady=resolve; });
    const idle = await open({argv:['/bin/sh','-c','echo "$PAPPAI_TERMINAL_SOCKET"; sleep 30']},false,
      text=>{ if (text.includes('\n')) pathReady(text.trim()); });
    const path = await socketPath;
    const imposter = connect(path);
    const chunks: Buffer[] = [];
    imposter.on('data',chunk=>chunks.push(chunk));
    const ended = once(imposter,'close');
    const data = Buffer.from(JSON.stringify({method:'discover',params:{actor},token:'other-terminal'}));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(data.length);
    imposter.write(Buffer.concat([header,data]));
    await ended;
    assert.match(Buffer.concat(chunks).toString(),/Terminal session expired/);
    assert.equal(rpcCalls,10);
    const waiting = await open({cli:{node:'profile',method:'wait',input:{}}});
    await preparing;
    let running!: () => void;
    const started = new Promise<void>(resolve=>{ running=resolve; });
    const interrupted = await open({argv:['pappai','cli','profile','login']},false,
      text=>{ if (text.includes('ready')) running(); });
    await started;
    const activeView = view!;
    assert.ok(existsSync(activeView.scratch!.source + '/file'));
    const sibling = await (await open({argv:['/bin/sh','-c',
      'test ! -e "$SCRATCH/file" && test ! -e "$SOURCE/file" && test ! -e "$SOCKET"'],
      env:{SCRATCH:activeView.scratch!.path,SOURCE:activeView.scratch!.source,SOCKET:path}},true)).closed;
    assert.deepEqual(sibling.statuses.at(-1),{exitCode:0});
    valid = false;
    terminals.checkSessions();
    await Promise.all([idle.closed,waiting.closed,cancelled,interrupted.closed]);
    await terminals.close();
    assert.equal(existsSync(path),false);
    assert.equal(existsSync(activeView.scratch!.source),false);
    assert.ok(activeView.revoked);
  } finally {
    await terminals.close();
    await new Promise(resolve=>server.close(resolve));
    rmSync(dir,{recursive:true,force:true});
    db.close();
  }
});
