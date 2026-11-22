import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createService } from '../src/server.ts';

test('a registered IPC runner validates and receives its own settings without process fields', async t=>{
  const dir = mkdtempSync(join(tmpdir(),'pappai-custom-runner-'));
  const entrypoint = join(dir,'adapter.cjs');
  writeFileSync(entrypoint,`
    process.on('message', msg=>{
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
  const service = createService({db,origin:'http://localhost'});
  t.after(async ()=>{await service.close();db.close();rmSync(dir,{recursive:true,force:true});});
  const actor = service.store.ensureAdmin('registry@example.test');
  const call = (node,method,data)=>service.controller.call(actor.id,{node,method,data,timeoutMs:3000});
  const settingsSchema={type:'object',properties:{prefix:{type:'string'}},required:['prefix'],additionalProperties:false};
  await call('~','$.runners.add',{name:'prepend',entrypoint,settingsSchema,config:{tool:'/private/tool'}});
  const runners = await call('~','$.runners.get',{});
  assert.deepEqual(runners.find(entry=>entry.name==='prepend').settingsSchema,settingsSchema);
  const source = prefix=>({manifest:{run:{type:'prepend',settings:{prefix,features:{
    format:{type:'method',version:'1',description:'prepend a prefix',schema:{input:{type:'string'}}}}}},
    executors:{mode:'oneShot'}}});
  const {id}=await call('~','$.app.create',{name:'formatter',permissions:[],source:source('test:')});
  await assert.rejects(call(id,'$.app.manifest.set',{source:source(17)}),/registered runner schema/);
  assert.equal(service.controller.help(actor.id,{node:id}).versions.format,'1');
  await call(id,'$.app.start',{});
  await assert.rejects(call('~','$.runners.restart',{name:'prepend',config:[]}),/config/);
  await call('~','$.runners.restart',{name:'prepend',config:{tool:'/private/new'}});
  assert.deepEqual(await call(id,'format','hello'),{text:'test:hello',command:false,cwd:false,config:{tool:'/private/new'},holdFirst:false});
});

test('registered profile host reads an input through the actual caller file view',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'pappai-profile-input-'));
  const entrypoint=join(dir,'adapter.cjs');
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
  `);
  const db=new DatabaseSync(':memory:');
  const service=createService({db,origin:'http://localhost'});
  t.after(async()=>{await service.close();db.close();rmSync(dir,{recursive:true,force:true});});
  const {store,controller}=service;
  const admin=store.ensureAdmin('owner@example.test');
  const call=(actor,node,method,data={})=>controller.call(actor,{node,method,data,timeoutMs:2500});
  await call(admin.id,'~','$.runners.add',{name:'fixture',entrypoint});
  const {id}=await call(admin.id,'~','$.profile.create',{name:'profile'});
  assert.deepEqual(await call(admin.id,id,'fixture.check',{file}),{bytes:16});
  assert.equal(controller.help(admin.id,{node:id}).versions['fixture.check'],'1');
  const restricted=store.create('~','user',{name:'reader',email:'reader@example.test',permissions:[{node:id,methods:'fixture.check'}]});
  store.setStatus(restricted.id,'working');
  await assert.rejects(call(restricted.id,id,'fixture.check',{file}),/unavailable or access denied/);
});
