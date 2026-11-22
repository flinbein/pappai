import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { ProcessRunner } from '../src/runner.ts';

const example = resolve('examples/extract-text');
function assignment(script?: string) {
  return {
    id: 'call-1', appId: 'app-1', from: 'user-1', method: 'message.extractText',
    data: { text: '  Привет  ' },
    settings: { command: process.execPath, cwd: example, args: script ? ['-e', script] : ['extract.cjs'] },
    sandbox: null,
  };
}

test('runner delivers one JSONL assignment while stdin stays open', {timeout: 10000}, async t => {
  const runner = new ProcessRunner();
  t.after(() => runner.close());
  const reply = once(runner, 'reply');
  const exit = once(runner, 'exit');
  runner.dispatch(assignment());
  assert.deepEqual((await reply)[0], {appId: 'app-1', id: 'call-1', result: 'Привет'});
  assert.deepEqual((await exit)[0], {appId: 'app-1', id: 'call-1'});
});

test('runner binds replies to the assigned call and refuses foreign ids', {timeout: 10000}, async t => {
  const runner = new ProcessRunner();
  t.after(() => runner.close());
  let replies = 0;
  runner.on('reply', () => replies++);
  const exit = once(runner, 'exit');
  runner.dispatch(assignment('console.log(JSON.stringify({id:"foreign",result:"incorrect"}))'));
  assert.match((await exit)[0].issue, /reply|id/i);
  assert.equal(replies, 0);
});

test('runner closes a missing executable and a rejected sandbox without a fallback', {timeout: 10000}, async t => {
  const runner = new ProcessRunner();
  t.after(() => runner.close());
  for (const job of [
    {...assignment(), settings: {...assignment().settings, command:'nonexistent-pappai-test-command'}},
    {...assignment(), sandbox:{read:['relative'],write:[],network:false}},
  ]) {
    const exit = once(runner, 'exit');
    runner.dispatch(job);
    const [failure] = await exit;
    assert.equal(failure.startFailed, true);
    assert.ok(failure.issue);
  }
});

test('loss of the common host is reported once and future dispatch fails', {timeout: 10000}, async t => {
  const runner = new ProcessRunner();
  t.after(() => runner.close());
  const loss = once(runner, 'lost');
  process.kill(runner.pid!, 'SIGKILL');
  assert.match((await loss)[0], /runner/i);
  assert.throws(() => runner.dispatch(assignment()), /runner/i);
});

test('failed OS namespace setup does not execute the workload on the host', {
  skip: process.env.PAPPAI_TEST_BWRAP_DENIED !== '1', timeout: 10000,
}, async t => {
  const runner = new ProcessRunner();
  t.after(() => runner.close());
  const replies: unknown[] = [];
  runner.on('reply', reply => replies.push(reply));
  const exit = once(runner, 'exit');
  const job = assignment('console.log(JSON.stringify({id:"call-1",result:"should never run"}))');
  runner.dispatch({...job, settings:{...job.settings,cwd:'/'},sandbox:{read:[],write:[],network:false}});
  const [result] = await exit;
  assert.ok(result.issue);
  assert.equal(result.startFailed,true);
  assert.deepEqual(replies,[]);
});

test('bubblewrap reads only granted inputs and uses a private network namespace', {
  skip: process.env.PAPPAI_TEST_BWRAP !== '1', timeout: 15000,
}, async t => {
  const dir = mkdtempSync(join('/var', 'pappai-grants-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const allowed = join(dir, 'allowed');
  const hidden = join(dir, 'hidden');
  writeFileSync(allowed, 'reader');
  writeFileSync(hidden, 'hidden');
  const hostNet = statSync('/proc/self/ns/net').ino;
  const script = `
    const fs = require('node:fs');
    console.log(JSON.stringify({id:'call-1',result:{
      text:fs.readFileSync(process.argv[1],'utf8'),hidden:fs.existsSync(process.argv[2]),
      net:fs.statSync('/proc/self/ns/net').ino
    }}));
  `;
  const runner = new ProcessRunner();
  t.after(() => runner.close());
  const msg = once(runner, 'reply');
  const completed = once(runner, 'exit');
  const original = assignment(script);
  runner.dispatch({...original, settings:{...original.settings, cwd:'/', args:['-e',script,allowed,hidden]},
    sandbox:{read:[allowed],write:[],network:false}});
  const reply = await Promise.race([msg, completed.then(([end]) => {throw new Error(end.issue || 'no reply')})]);
  assert.equal(reply[0].result.text,'reader');
  assert.equal(reply[0].result.hidden,false);
  assert.notEqual(reply[0].result.net,hostNet);
});

test('sandbox can enter a work directory without receiving its contents', {
  skip: process.env.PAPPAI_TEST_BWRAP !== '1', timeout: 10000,
}, async t => {
  const dir = mkdtempSync(join('/var', 'pappai-cwd-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  writeFileSync(join(dir, 'private'), 'hidden');
  const script = 'console.log(JSON.stringify({id:"call-1",result:[process.cwd(),require("node:fs").readdirSync(".")]}))';
  const runner = new ProcessRunner();
  t.after(() => runner.close());
  const reply = once(runner, 'reply');
  const exit = once(runner, 'exit');
  runner.dispatch({...assignment(script), settings: {cwd:dir,command:'node',args:['-e',script]},
    sandbox:{read:[],write:[],network:false}});
  const [line] = await Promise.race([reply,exit.then(([end])=>{throw new Error(end.issue || 'no reply')})]);
  assert.deepEqual(line.result,[dir,[]]);
});

test('sandbox distinguishes exec failure from a workload returning nonzero', {
  skip: process.env.PAPPAI_TEST_BWRAP !== '1', timeout: 10000,
}, async t => {
  const runner = new ProcessRunner();
  t.after(() => runner.close());
  for (const [command, startFailed] of [['/bin/pappai-missing', true], ['/bin/false', false]] as const) {
    const exit = once(runner, 'exit');
    runner.dispatch({...assignment(),settings:{cwd:'/',command},sandbox:{read:[],write:[],network:false}});
    const [end] = await exit;
    assert.equal(!!end.startFailed,startFailed);
    assert.ok(end.issue);
  }
});
