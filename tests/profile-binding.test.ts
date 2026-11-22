import { EventEmitter } from 'node:events';
import { Controller } from '../src/controller.ts';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Store } from '../src/store.ts';
import { createService } from '../src/server.ts';

test('profile membership gates first launch and limits both filesystem and method permits', async t=>{
  const db=new DatabaseSync(':memory:');
  const service=createService({db,origin:'http://localhost'});
  t.after(async ()=>{await service.close();db.close();});
  const {store,controller}=service;
  const admin=store.ensureAdmin('profiles@example.test');
  const call=(actor,node,method,data={})=>controller.call(actor,{node,method,data,timeoutMs:3000});
  const {id:profile}=await call(admin.id,'~','$.profile.create',{name:'limited',permissions:[{methods:'echo',read:'/work'}]});
  const manifest={run:{type:'process',settings:{command:'echo',cwd:process.cwd(),features:{
    echo:{type:'method',version:'1',description:'example'}}}},executors:{mode:'oneShot'}};
  const {id:app}=await call(admin.id,'~','$.app.create',{name:'actor',permissions:null,profile,source:{manifest}});
  assert.equal((await call(admin.id,app,'$.app.get')).profile,profile);
  await call(admin.id,profile,'$.profile.enable');
  await call(admin.id,app,'$.app.start');
  await assert.rejects(call(admin.id,app,'echo'),/profile/i);
  assert.equal(store.get(app).status,'error');
  await call(admin.id,profile,'$.profile.scope.set',{scope:[app]});
  await call(admin.id,app,'$.app.start');
  assert.equal(store.allows(app,app,'echo'),true);
  assert.equal(store.allows(app,app,'root'),false);
  assert.equal(store.isAdmin(app),false);
  assert.equal(store.allowsFile(app,'/work/file'),true);
  assert.equal(store.allowsFile(app,'/work/file',true),false);
  assert.equal(store.sandbox(app).network,false);
  await call(admin.id,app,'$.app.manifest.set',{source:{manifest}});
  assert.equal(store.get(app).profile,profile);
  const reopened=new Store(db);
  assert.equal(reopened.get(app).profile,profile);
  assert.equal(reopened.get(profile).type,'profile');
});

test('revoked profile stops a reserved persistent executor before its first delivery', async t=>{
  const db=new DatabaseSync(':memory:'); t.after(()=>db.close());
  const store=new Store(db);
  const admin=store.ensureAdmin('owner@example.test');
  const profile=store.create('~','profile',{name:'test',scope:[true],permissions:null});
  store.manage(admin.id,profile.id,'$.profile.enable',{});
  const app=store.create('~','app',{name:'worker',profile:profile.id,permissions:null,manifest:{
    run:{type:'fixture',settings:{features:{answer:{type:'method',version:'1',description:'test',
      schema:{output:{type:'integer'}}}}}},executors:{mode:'persistent',maxRestarts:4}}});
  store.setStatus(app.id,'working');
  const jobs=[],stops=[],delivered=[];
  const runner=Object.assign(new EventEmitter(),{
    dispatch:job=>jobs.push(job),stop:id=>stops.push(id),deliver:(id,item)=>delivered.push(item),
  });
  const controller=new Controller(store,runner);
  const call=(node,method,data={})=>controller.call(admin.id,{node,method,data,timeoutMs:5000});
  const reply=call(app.id,'answer');
  const [job]=jobs;
  assert.equal(job.holdFirst,true);
  assert.equal(job.profileId,profile.id);
  assert.deepEqual(job.outputSchema,{type:'integer'});
  await call(profile.id,'$.profile.scope.set',{scope:[]});
  assert.equal(store.get(app.id).status,'error');
  assert.deepEqual(stops,[job.id]);
  runner.emit('started',{id:job.id,appId:app.id});
  assert.deepEqual(delivered,[]);
  runner.emit('exit',{id:job.id,appId:app.id});
  await assert.rejects(reply);
  assert.equal(jobs.length,1);
});

test('upgrading a version one database preserves nodes and foreign-key dependents', t=>{
  const db=new DatabaseSync(':memory:'); t.after(()=>db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE store_migrations(version INTEGER PRIMARY KEY);
    INSERT INTO store_migrations VALUES(1);
    CREATE TABLE nodes(id TEXT PRIMARY KEY,parentId TEXT REFERENCES nodes(id),type TEXT,name TEXT,status TEXT,email TEXT UNIQUE,permissions TEXT,manifest TEXT,lastIssue TEXT);
    INSERT INTO nodes VALUES('~',NULL,'workspace','root','working',NULL,'null',NULL,NULL);
    INSERT INTO nodes VALUES('app','~','app','legacy','working',NULL,'[]','{}','old issue');
    CREATE TABLE legacy_data(app TEXT REFERENCES nodes(id) ON DELETE CASCADE,value TEXT);
    INSERT INTO legacy_data VALUES('app','preserved');`);
  const store=new Store(db);
  assert.equal(store.get('app').lastIssue,'old issue');
  assert.equal(store.get('app').profile,null);
  assert.equal(db.prepare('SELECT value FROM legacy_data').get().value,'preserved');
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal(store.create('~','profile',{name:'new'}).type,'profile');
});

test('profile revocation invalidates its file view and normal graceful stop retains method rights', async t=>{
  const db=new DatabaseSync(':memory:'); t.after(()=>db.close());
  const store=new Store(db);
  const owner=store.ensureAdmin('graceful@example.test');
  const profile=store.create('~','profile',{name:'authority',permissions:null,scope:[true]});
  store.manage(owner.id,profile.id,'$.profile.enable',{});
  const manifest={run:{type:'fixture',settings:{features:{go:{type:'method',version:'1',description:'go'}}}},executors:{mode:'oneShot'}};
  const from=store.create('~','app',{name:'caller',profile:profile.id,permissions:null,manifest});
  const to=store.create('~','app',{name:'target',permissions:null,manifest});
  for(const node of [from,to]) store.setStatus(node.id,'working');
  const jobs=[],revoked=[],responses=[];
  const runner=Object.assign(new EventEmitter(),{dispatch:j=>jobs.push(j),stop(){},deliver(){},respond:(_worker,id,data)=>responses.push({id,...data})});
  const controller=new Controller(store,runner,{executorProfileRevoked:id=>revoked.push(id)});
  const call=(node,method,data={})=>controller.call(owner.id,{node,method,data,timeoutMs:1500});
  const outer=call(from.id,'go');
  const first=jobs[0];
  runner.emit('started',first);
  await call(from.id,'$.app.stop');
  runner.emit('request',{appId:from.id,workerId:first.id,id:'r',method:'call',params:{node:to.id,method:'go',data:{}}});
  const target=jobs[1];
  assert.ok(target,'already running executor retains APP + PROFILE method authorization during ordinary stop');
  runner.emit('reply',{...target,result:'ok'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(responses[0].result,'ok');
  await call(from.id,'$.app.profile.set',{profile:null});
  assert.deepEqual(revoked,[first.id]);
  runner.emit('request',{appId:from.id,workerId:first.id,id:'late',method:'call',params:{node:to.id,method:'go',data:{}}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(responses.find(r=>r.id==='late').error.message,/revoked/);
  runner.emit('reply',{...first,result:'done'});
  assert.equal(await outer,'done');
  runner.emit('exit',first);
  runner.emit('exit',target);
});

test('declared Codex interrupts reach a busy persistent worker with normal method authorization',async t=>{
  const db=new DatabaseSync(':memory:'); t.after(()=>db.close());
  const store=new Store(db), owner=store.ensureAdmin('interrupt@example.test');
  const app=store.create('~','app',{name:'agent',manifest:{run:{type:'codex',settings:{features:{
    go:{type:'method',description:'turn',version:'1'},
    'agent.interrupt':{type:'method',description:'stop current turn',version:'1',schema:{
      input:{type:'object'},output:{type:'object',properties:{interrupted:{type:'boolean'}},required:['interrupted']}}}}}},executors:{mode:'persistent'}}});
  const visitor=store.create('~','user',{name:'visitor',email:'visitor@example.test',permissions:[{methods:'go'}]});
  store.setStatus(visitor.id,'working');
  store.setStatus(app.id,'working');
  const jobs=[],notifications=[];
  const runner=Object.assign(new EventEmitter(),{dispatch:job=>jobs.push(job),notify:(worker,record)=>notifications.push({worker,record})});
  const controller=new Controller(store,runner);
  const call=(actor,method,data={})=>controller.call(actor,{node:app.id,method,data,timeoutMs:300});
  await assert.rejects(call(owner.id,'agent.interrupt'),/No active/);
  assert.equal(jobs.length,0);
  const turn=call(owner.id,'go');
  const [job]=jobs;
  runner.emit('started',job);
  await assert.rejects(call(visitor.id,'agent.interrupt'),/denied/);
  await assert.rejects(call(owner.id,'agent.interrupt','text'),/schema/);
  assert.equal(notifications.length,0);
  const control=call(owner.id,'agent.interrupt');
  const [{worker,record}]=notifications;
  assert.equal(worker,job.id);
  assert.ok(record.interrupt);
  runner.emit('reply',{appId:app.id,workerId:job.id,id:record.interrupt,result:{interrupted:true}});
  assert.deepEqual(await control,{interrupted:true});
  runner.emit('reply',{appId:app.id,workerId:job.id,id:job.id,result:'done'});
  assert.equal(await turn,'done');
  assert.equal(jobs.length,1);
});
