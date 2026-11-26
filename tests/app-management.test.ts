import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { Store } from '../src/store.ts';
import { Controller } from '../src/controller.ts';

const manifest = JSON.parse(readFileSync(new URL('../examples/extract-text/manifest.json', import.meta.url)));
const method = 'message.extractText';
function setup(t) {
  const db = new DatabaseSync(':memory:');
  const store = new Store(db);
  const admin = store.ensureAdmin('admin@example.test');
  const runner = Object.assign(new EventEmitter(), {
    jobs: [], stops: [], dispatch(job) { this.jobs.push(job); }, stop(id) { this.stops.push(id); },
    rejectReply() {},
  });
  const app = store.create('~','app',{name:'extract', permissions:[], manifest});
  const controller = new Controller(store,runner);
  const call = (name, data = {}, version?) => controller.call(admin.id,{node:app.id, method:name, data, version});
  t.after(() => { runner.emit('lost','test shutdown'); db.close(); });
  return {store, runner, app, call, controller, admin};
}

test('stop rejects queued work and lets the assigned process reply until exit', async t => {
  const {runner,call} = setup(t);
  await call('$.lifecycle.start');
  const active = call(method,{text:'one'});
  const queued = call(method,{text:'two'});
  const results = Promise.allSettled([active,queued]);
  const before = await call('$.app.executors.get');
  assert.deepEqual([before.active,before.queued,before.limit],[1,1,1]);
  await call('$.lifecycle.stop');
  await call('$.lifecycle.stop');
  assert.equal((await call('$.lifecycle.get')).status,'stopping');
  await assert.rejects(call('$.lifecycle.start'),/stopping/i);
  await assert.rejects(call(method,{text:'later'}),/not working/i);
  assert.deepEqual(runner.stops,[runner.jobs[0].id]);
  runner.emit('reply',{...runner.jobs[0],result:'done'});
  runner.emit('exit',runner.jobs[0]);
  assert.equal((await results)[0].value,'done');
  assert.match((await results)[1].reason.message,/stop/i);
  assert.equal((await call('$.lifecycle.get')).status,'stopped');
  assert.equal(runner.jobs.length,1);
});

test('manifest replacement validates before saving and reconciles the active contract', async t => {
  const {call,runner,store,app,controller,admin} = setup(t);
  await call('$.lifecycle.start');
  const first = call(method,{text:'one'});
  const pinned = call(method,{text:'two'},'1');
  const compatible = call(method,{text:'three'});
  const results = Promise.allSettled([first,pinned,compatible]);
  const next = structuredClone(manifest);
  const feature = next.run.settings.features[method];
  feature.version = '2';
  feature.schema.output = {type:'integer'};
  await assert.rejects(call('$.app.manifest.set',{source:{manifest:{}}}),/manifest/i);
  assert.deepEqual(await call('$.app.manifest.get'),{manifest});
  await call('$.app.manifest.set',{source:{manifest:next}});
  assert.deepEqual(store.get(app.id).manifest,next);
  assert.equal(controller.help(admin.id,{node:app.id})[method].version,'2');
  runner.emit('reply',{...runner.jobs[0],result:'old format'});
  runner.emit('reply',{...runner.jobs[0],result:1});
  runner.emit('exit',runner.jobs[0]);
  assert.equal(runner.jobs[1].data.text,'three');
  runner.emit('reply',{...runner.jobs[1],result:3});
  assert.deepEqual((await results).map(r=>r.status==='fulfilled'?r.value:r.reason.message),[1,'Method version mismatch',3]);
});

test('an unconfirmed kill fails the APP and releases the slot', async t => {
  const {call,runner} = setup(t);
  await call('$.lifecycle.start');
  const pending = call(method,{text:'one'});
  await call('$.lifecycle.stop');
  runner.emit('exit',{...runner.jobs[0],stopFailed:true,issue:'SIGKILL not confirmed'});
  await assert.rejects(pending,/SIGKILL/);
  assert.deepEqual(await call('$.app.get'),{manifestChanged:false,lastIssue:'SIGKILL not confirmed'});
  assert.equal((await call('$.lifecycle.get')).status,'error');
  assert.equal((await call('$.app.executors.get')).active,0);
  await assert.rejects(call('$.lifecycle.start',{force:true}),/schema/);
  await assert.rejects(call('$.lifecycle.start'),/forceStart/);
  await call('$.app.forceStart');
  assert.deepEqual(await call('$.lifecycle.get'),{status:'working'});
});
