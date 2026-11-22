import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { Controller } from '../src/controller.ts';
import { ProcessRunner } from '../src/runner.ts';
import { Store } from '../src/store.ts';

const method = {type:'method',description:'test',version:'1'};
const event = {type:'event',description:'test',version:'1'};
function manifest(features,script = '',executors = {mode:'oneShot',poolSize:2},subscriptions = []) {
  return {run:{type:'process',settings:{command:process.execPath,cwd:process.cwd(),args:['-e',script],features}},executors,subscriptions};
}
function setup(t,real = false) {
  const db = new DatabaseSync(':memory:');
  const store = new Store(db);
  const admin = store.ensureAdmin('process-test@example.test').id;
  const runner = real ? new ProcessRunner() : Object.assign(new EventEmitter(),{
    jobs:[],writes:[],stops:[],dispatch(job){this.jobs.push(job);},deliver(id,item){this.writes.push({id,item});},
    stop(id){this.stops.push(id);},rejectReply(){},respond(){},
  });
  const ctrl = new Controller(store,runner);
  const app = (name,manifest,permissions=null)=>store.create('~','app',{name,manifest,permissions}).id;
  const call = (node,method,data={},options={})=>ctrl.call(admin,{node,method,data,timeoutMs:5000,...options});
  t.after(async()=>{if(real) await runner.close(); db.close();});
  return {admin,store,runner,ctrl,app,call};
}

test('a subscribed persistent process calls the publisher while both of its oneShot slots are occupied', {timeout:12000}, async t=>{
  const {runner,app,call} = setup(t,true);
  const publisher = app('publisher',manifest({start:method,echo:method,work:event},`
    const rl = require('node:readline').createInterface({input:process.stdin});
    let assignment;
    rl.on('line', line=>{
      const m = JSON.parse(line);
      if (m.method==='echo') {
        process.stdout.write(JSON.stringify({id:m.id,result:m.data})+'\\n',()=>process.exit());
      } else if (m.method==='start') {
        assignment = m;
        console.log(JSON.stringify({id:'local',method:'publish',params:{event:'work',data:m.data.payload}}));
      } else if (m.id==='local') {
        if (m.error) throw Error(m.error.message);
        console.log(JSON.stringify({id:'wait',method:'call',params:{node:assignment.data.subscriber,method:'result'}}));
      } else if (m.id==='wait') {
        process.stdout.write(JSON.stringify({id:assignment.id,result:m.result})+'\\n',()=>process.exit());
      }
    });
  `));
  const subscriber = app('subscriber',manifest({result:method},`
    const rl = require('node:readline').createInterface({input:process.stdin});
    let result;
    const waiting=[];
    function reply(){ if(result) for (const id of waiting.splice(0)) console.log(JSON.stringify({id,result})); }
    rl.on('line', line=>{
      const m = JSON.parse(line);
      if(m.event==='work') console.log(JSON.stringify({id:'local',method:'call',params:{node:m.from,method:'echo',data:m.data}}));
      else if(m.id==='local') { result=m.result; reply(); }
      else if(m.method==='result'){ waiting.push(m.id);reply(); }
    });
  `,{mode:'persistent'},[{node:publisher,events:'work'}]));
  await call(subscriber,'$.app.start');
  await call(publisher,'$.app.start');
  const started = [];
  runner.on('started',job=>started.push(job));
  const accepted = call(publisher,'start',{subscriber,payload:{text:'hello'}});
  const result = await call(subscriber,'result');
  assert.deepEqual(result,{text:'hello'});
  assert.deepEqual(await accepted,{text:'hello'});
  assert.equal(started.filter(w=>w.appId === publisher).length,2);
  assert.equal(started.filter(w=>w.appId === subscriber).length,1);
  await call(subscriber,'$.app.stop');
});

test('personal rules are atomic, survive restart and cannot bypass event permits',async t=>{
  const {store,runner,ctrl,app,call} = setup(t);
  const source = app('source',manifest({work:event}));
  const recipient = app('receiver',manifest({}),[{node:source,events:'work'}]);
  const hidden = app('hidden',manifest({}),[]);
  await Promise.all([source,recipient,hidden].map(id=>call(id,'$.app.start')));
  const rule = {id:'$first',node:source,events:{work:{type:'integer'}}};
  for(const id of [recipient,hidden]) await call(id,'$.node.subscriptions.add',{subscriptions:[rule]});
  await assert.rejects(call(recipient,'$.node.subscriptions.add',{subscriptions:[rule]}),/duplicate/i);
  await assert.rejects(call(recipient,'$.node.subscriptions.delete',{ids:[rule.id,'missing']}),/not found/i);
  assert.deepEqual((await call(recipient,'$.node.subscriptions.get')).subscriptions,[rule]);
  const restored = new Controller(store,runner);
  restored.publish(source,{event:'work',data:'ignored'});
  restored.publish(source,{event:'work',data:1});
  assert.deepEqual(runner.jobs.map(j=>[j.appId,j.event,j.subscription]),[[recipient,'work','$first']]);
  assert.throws(()=>ctrl.publish(source,{event:'$.app.statusChanged'}),/publication/i);
});

test('persistent transport waits for stdin completion and preserves queued work through restart', async t=>{
  const {runner,app,call} = setup(t);
  const id = app('service',manifest({work:method},'',{mode:'persistent'},[{node:'.',events:'$.app.statusChanged'}]));
  await call(id,'$.app.start');
  const first = runner.jobs[0];
  assert.equal(first.event,'$.app.statusChanged');
  const pending = call(id,'work');
  assert.equal(runner.writes.length,0);
  await call(id,'$.app.restart');
  assert.deepEqual(runner.stops,[first.id]);
  runner.emit('written',{appId:id,workerId:first.id,id:first.id});
  assert.equal(runner.writes.length,0);
  runner.emit('exit',first);
  const second = runner.jobs[1];
  assert.equal(second.method,'work');
  assert.notEqual(second.id,first.id);
  runner.emit('reply',{id:second.id,appId:id,workerId:first.id,result:'late'});
  runner.emit('reply',{id:second.id,appId:id,workerId:second.id,result:'ok'});
  assert.equal(await pending,'ok');
});

test('shared bounded queue evicts oldest minimum priority and preserves FIFO ties', async t=>{
  const {runner,app,call} = setup(t);
  const id = app('worker',manifest({low:method,high:{...method,priority:10,canEvict:true}},'',{mode:'oneShot',poolSize:1}));
  await call(id,'$.app.start');
  const results = Promise.allSettled(Array.from({length:101},(_,index)=>call(id,'low',{index})));
  await assert.rejects(call(id,'low'),/full/i);
  const urgent = call(id,'high');
  runner.emit('reply',{...runner.jobs[0],result:'ok'});
  runner.emit('exit',runner.jobs[0]);
  assert.equal(runner.jobs[1].method,'high');
  runner.emit('reply',{...runner.jobs[1],result:'ok'});
  assert.equal(await urgent,'ok');
  runner.emit('exit',runner.jobs[1]);
  assert.equal(runner.jobs[2].data.index,2);
  await call(id,'$.app.stop');
  runner.emit('exit',runner.jobs[2]);
  const settled = await results;
  assert.match(settled[1].reason.message,/evicted/i);
});

test('oneShot launch failure withdraws sibling reservations while an accepted call can still reply',async t=>{
  const {runner,app,call}=setup(t);
  const id=app('pool',manifest({work:method},'',{mode:'oneShot',poolSize:3}));
  await call(id,'$.app.start');
  const settled=Promise.allSettled([call(id,'work'),call(id,'work'),call(id,'work'),call(id,'work')]);
  const [accepted,failed,stale]=runner.jobs;
  runner.emit('started',accepted);
  runner.emit('written',{appId:id,workerId:accepted.id,id:accepted.id});
  runner.emit('exit',{...failed,startFailed:true,issue:'launch failed'});
  assert.deepEqual(runner.stops,[stale.id]);
  assert.equal((await call(id,'$.app.get')).status,'error');
  await call(id,'$.app.start');
  runner.emit('started',stale);
  runner.emit('exit',{...stale,startFailed:true,issue:'stale failure'});
  runner.emit('reply',{...accepted,result:42});
  runner.emit('exit',accepted);
  assert.equal((await call(id,'$.app.get')).status,'working');
  assert.deepEqual((await settled).map(r=>r.status==='fulfilled'?r.value:r.reason.message),
    [42,'launch failed','launch failed','launch failed']);
  assert.equal(runner.writes.length,1);
});

test('persistent failure retains waiting work until retries are exhausted; manual start resets count',async t=>{
  const {runner,app,call}=setup(t);
  const id=app('service',manifest({work:method},'',{mode:'persistent',maxRestarts:1},[{node:'.',events:'$.app.executor.failed'}]));
  await call(id,'$.app.start');
  const first=call(id,'work');
  const next=call(id,'work');
  const assigned=runner.jobs[0];
  runner.emit('started',assigned);
  runner.emit('exit',{...assigned,issue:'crash'});
  await assert.rejects(first,/crash/);
  assert.equal((await call(id,'$.app.get')).status,'working');
  const retry=runner.jobs[1];
  assert.equal(retry.method,'work');
  runner.emit('started',retry);
  runner.emit('exit',{...retry,issue:'crash again'});
  await assert.rejects(next,/crash again/);
  assert.equal((await call(id,'$.app.get')).status,'error');
  assert.equal((await call(id,'$.app.executors.get')).queued,0);
  await call(id,'$.app.start');
  const fresh=call(id,'work');
  runner.emit('exit',{...runner.jobs[2],issue:'new crash'});
  await assert.rejects(fresh,/crash/);
  assert.equal((await call(id,'$.app.get')).status,'working');
  assert.equal(runner.jobs[3].event,'$.app.executor.failed');
});

test('loss of a retired runner frees its slot without failing the new runner of the same APP',async t=>{
  const {runner,ctrl,app,call}=setup(t);
  const old=manifest({work:method},'',{mode:'oneShot',poolSize:1});
  const id=app('migrated',old);
  await call(id,'$.app.start');
  const first=call(id,'work');
  runner.emit('started',runner.jobs[0]);
  const next=structuredClone(old);
  next.run.type='next';
  ctrl.applyManifest(id,next);
  const second=call(id,'work');
  runner.emit('lost','old runner disconnected','process');
  await assert.rejects(first,/disconnected/);
  assert.equal((await call(id,'$.app.get')).status,'working');
  assert.equal(runner.jobs[1].runnerType,'next');
  runner.emit('reply',{...runner.jobs[1],result:'new'});
  assert.equal(await second,'new');
});

test('an authenticated executor can complete an outgoing method during graceful stop',async t=>{
  const {store,runner,app,call,ctrl}=setup(t);
  const caller=app('caller',manifest({work:method}));
  const callee=app('callee',manifest({work:method}));
  await call(caller,'$.app.start');
  await call(callee,'$.app.start');
  const pending=call(caller,'work');
  const original=runner.jobs[0];
  runner.emit('started',original);
  const opened=[];
  ctrl.hooks.callOpened=(...args)=>opened.push(args);
  await call(caller,'$.app.stop');
  assert.equal(store.get(caller).status,'stopping');
  await assert.rejects(ctrl.call(caller,{node:callee,method:'work'}),/permission/i);
  runner.emit('request',{appId:caller,workerId:original.id,id:'local',method:'call',params:{node:callee,method:'work'}});
  assert.equal(runner.jobs[1].appId,callee);
  assert.equal(opened[0][4],original.id);
  runner.emit('reply',{...runner.jobs[1],result:true});
  runner.emit('reply',{...original,result:true});
  runner.emit('exit',original);
  assert.equal(await pending,true);
});
