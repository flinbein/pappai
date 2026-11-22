import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Controller } from '../src/controller.ts';
import { ProcessRunner } from '../src/runner.ts';
import { Store } from '../src/store.ts';

test('losing a real runner host closes two calls and removes processes from its sandbox', {
  skip: process.env.PAPPAI_TEST_BWRAP !== '1', timeout: 15000,
}, async t => {
  const dir = mkdtempSync('/var/pappai-loss-');
  const log = join(dir, 'starts'), heartbeat = join(dir, 'heartbeat');
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const db = new DatabaseSync(':memory:');
  const store = new Store(db);
  t.after(() => db.close());
  const owner = store.ensureAdmin('runner-test@localhost.test');
  const runner = new ProcessRunner();
  t.after(() => runner.close());
  const controller = new Controller(store, runner);
  // Observe actual receipt of the JSONL call and a living sandbox descendant
  // before killing the host. A fork acknowledgement alone would be too early.
  const descendant = `setInterval(()=>require('node:fs').appendFileSync(process.argv[1],'x'),40)`;
  const script = `
    process.stdin.once('data',input=>{
      require('node:fs').appendFileSync(process.argv[1],JSON.parse(input).id+'\\n');
      require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)},process.argv[2]]);
      setInterval(()=>{},1000);
    });
  `;
  const app = store.create('~','app',{name:'loss-probe',permissions:[{write:dir}],manifest:{
    executors:{mode:'oneShot',poolSize:1},run:{type:'process',settings:{
      command:'node',cwd:dir,args:['-e',script,log,heartbeat],
      features:{work:{type:'method',description:'',version:'1'}}
    }}
  }});
  store.setStatus(app.id,'working');
  const input = {node:app.id,method:'work',timeoutMs:8000};
  const calls = Promise.allSettled([controller.call(owner.id,input),controller.call(owner.id,input)]);
  for (let i = 0; i < 100 && !existsSync(heartbeat); i++) await delay(30);
  assert.ok(existsSync(heartbeat), 'executor and its descendant are active');
  process.kill(runner.pid!, 'SIGKILL');
  for (const result of await calls) {
    assert.equal(result.status,'rejected');
    if (result.status === 'rejected') assert.match(result.reason.message,/runner/i);
  }
  assert.equal(store.get(app.id)?.status,'error');
  assert.equal(readFileSync(log,'utf8').trim().split('\n').length,1);
  await delay(200);
  const finalHeartbeat = readFileSync(heartbeat,'utf8');
  await delay(200);
  assert.equal(readFileSync(heartbeat,'utf8'),finalHeartbeat);
});
