import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createService } from '../src/server.ts';

test('a registered IPC runner validates and receives its own settings without process fields', async t=>{
  const dir = mkdtempSync(join(tmpdir(),'pappai-custom-runner-'));
  const install=join(dir,'prepend');
  mkdirSync(install);
  const entrypoint = join(install,'adapter.cjs');
  const settingsSchema={type:'object',properties:{prefix:{type:'string'}},required:['prefix'],additionalProperties:false};
  writeFileSync(entrypoint,`
    process.send({type:'runnerReady',payload:{methods:{version:{description:'Runner version'}},settingsSchema:${JSON.stringify(settingsSchema)}}});
    process.on('message', msg=>{
      if(msg.type==='runnerCall') return process.send({type:'runnerReply',payload:{id:msg.id,result:process.env.PAPPAI_RUNNER_NAME}});
      if (msg.type==='close') return process.disconnect();
      if (msg.type!=='dispatch') return;
      const {id,appId,data,settings,holdFirst}=msg.job;
      const send=(type,fields={})=>process.send({type,payload:{appId,id,...fields}});
      send('started');
      send('written',{workerId:id});
      send('reply',{result:{text:settings.prefix+data,command:'command' in settings,cwd:'cwd' in settings,config:JSON.parse(process.env.PAPPAI_RUNNER_CONFIG),holdFirst}});
      send('exit');
    });
  `);
  const db = new DatabaseSync(':memory:');
  const service = createService({db,origin:'http://localhost',runnerRoot:dir});
  t.after(async ()=>{await service.close();db.close();rmSync(dir,{recursive:true,force:true});});
  const actor = service.store.ensureAdmin('registry@example.test');
  const call = (node,method,data)=>service.controller.call(actor.id,{node,method,data,timeoutMs:3000});
  await assert.rejects(call('~','$.runners.add',{name:'prepend',entrypoint,config:{}}),/schema/);
  await call('~','$.runners.add',{name:'prepend',entrypoint});
  const help=service.controller.help(actor.id,{node:'~',features:'runners.prepend.version'});
  assert.equal(help['runners.prepend.version']?.description,'Runner version');
  const runners = await call('~','$.runners.list',{});
  assert.deepEqual(runners.find(entry=>entry.name==='prepend').settingsSchema,settingsSchema);
  const source = prefix=>({manifest:{run:{type:'prepend',settings:{prefix,features:{
    format:{type:'method',version:'1',description:'prepend a prefix',schema:{input:{type:'string'}}}}}},
    executors:{mode:'oneShot'}}});
  const {id}=await call('~','$.children.createApp',{name:'formatter',permissions:[],source:source('test:')});
  await assert.rejects(call(id,'$.app.manifest.set',{source:source(17)}),/registered runner schema/);
  assert.equal(service.controller.help(actor.id,{node:id}).format.version,'1');
  await call(id,'$.lifecycle.start',{});
  assert.deepEqual(await call(id,'format','hello'),{text:'test:hello',command:false,cwd:false,config:{},holdFirst:false});
  const broken=join(install,'broken.cjs');
  writeFileSync(broken,'process.exit(1);');
  await assert.rejects(call('~','$.runners.restart',{name:'prepend',entrypoint:broken}),/readiness/);
  assert.equal(await call('~','runners.prepend.version',{}),'prepend');
  const replacement=join(install,'replacement.cjs');
  writeFileSync(replacement,`process.send({type:'runnerReady',payload:{}});process.on('message',m=>{if(m.type==='close')process.disconnect()})`);
  await call('~','$.runners.restart',{name:'prepend',entrypoint:replacement});
  assert.equal((await call('~','$.runners.list',{})).find(r=>r.name==='prepend').previousEntrypoint,entrypoint);
  await call('~','$.runners.restart',{name:'prepend',entrypoint});
  const restricted=service.store.create('~','user',{name:'limited',email:'limited@example.test',permissions:[{node:'~',methods:true}]});
  service.store.setStatus(restricted.id,'working');
  await assert.rejects(service.controller.call(restricted.id,{node:'~',method:'runners.prepend.version',data:{}}),/Permission denied/);
  await call('~','$.runners.delete',{name:'prepend'});
  assert.equal(existsSync(install),false);
  assert.equal(service.store.get(id)?.status,'error');
  mkdirSync(install);
  writeFileSync(entrypoint,`process.send({type:'runnerReady',payload:{}});process.on('message',m=>{
    if (m.type==='close')return process.disconnect();
    if (m.type==='dispatch'){const {id,appId}=m.job;process.send({type:'reply',payload:{id,appId,result:'reinstalled'}})}
  });`);
  await call('~','$.runners.add',{name:'prepend',entrypoint});
  await call(id,'$.lifecycle.start',{});
  assert.equal(await call(id,'format','hello'),'reinstalled');
});

test('unregistering a legacy installation preserves its shared directory',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'pappai-old-layout-'));
  const legacy=join(dir,'shared');
  mkdirSync(legacy);
  const entrypoint=join(legacy,'index.cjs');
  writeFileSync(entrypoint,'process.on("message",m=>{if(m.type==="close")process.disconnect()})');
  const db=new DatabaseSync(':memory:');
  db.exec('CREATE TABLE installed_runners(name TEXT PRIMARY KEY,entrypoint TEXT,enabled INTEGER NOT NULL)');
  db.prepare('INSERT INTO installed_runners VALUES(?,?,0)').run('old',entrypoint);
  const service=createService({db,origin:'http://localhost',runnerRoot:dir});
  t.after(async()=>{await service.close();db.close();rmSync(dir,{recursive:true,force:true});});
  const actor=service.store.ensureAdmin('operator@example.test');
  const call=(method:string,data:unknown)=>service.controller.call(actor.id,{node:'~',method,data});
  await call('$.runners.delete',{name:'old'});
  assert.equal(existsSync(entrypoint),true);
  mkdirSync(join(dir,'old'));
  await assert.rejects(call('$.runners.add',{name:'old',entrypoint}),/named runner directory/);
});

test('registered profile host reads an input through the actual caller file view',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'pappai-profile-input-'));
  mkdirSync(join(dir,'fixture'));
  const entrypoint=join(dir,'fixture','adapter.cjs');
  const file=join(dir,'synthetic.json');
  writeFileSync(file,'{"example":true}');
  writeFileSync(entrypoint,`
    process.on('message', msg=>{
      if (msg.type==='close') return process.disconnect();
      if (msg.type==='profileCall') process.send({type:'profileRead',payload:{id:msg.id,requestId:'read',path:msg.data.file}});
      if (msg.type==='profileFile') process.send({type:'profileReply',payload:{id:msg.id,
        ...(msg.error ? {error:msg.error} : {result:{bytes:Buffer.from(msg.content,'base64').length}})}});
    });
    process.send({type:'profileMethods',payload:{methods:['check']}});
    process.send({type:'runnerReady',payload:{}});
  `);
  const db=new DatabaseSync(':memory:');
  const service=createService({db,origin:'http://localhost',runnerRoot:dir});
  t.after(async()=>{await service.close();db.close();rmSync(dir,{recursive:true,force:true});});
  const {store,controller}=service;
  const admin=store.ensureAdmin('owner@example.test');
  const call=(actor,node,method,data={})=>controller.call(actor,{node,method,data,timeoutMs:2500});
  await call(admin.id,'~','$.runners.add',{name:'fixture',entrypoint});
  const {id}=await call(admin.id,'~','$.children.createProfile',{name:'profile'});
  assert.deepEqual(await call(admin.id,id,'fixture.check',{file}),{bytes:16});
  assert.equal(controller.help(admin.id,{node:id})['fixture.check'].version,'1');
  const restricted=store.create('~','user',{name:'reader',email:'reader@example.test',permissions:[{node:id,methods:'fixture.check'}]});
  store.setStatus(restricted.id,'working');
  await assert.rejects(call(restricted.id,id,'fixture.check',{file}),/unavailable or access denied/);
});
