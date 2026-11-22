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
      send('reply',{result:{text:settings.prefix+data,command:'command' in settings,cwd:'cwd' in settings,holdFirst}});
      send('exit');
    });
  `);
  const db = new DatabaseSync(':memory:');
  const service = createService({db,origin:'http://localhost'});
  t.after(async ()=>{await service.close();db.close();rmSync(dir,{recursive:true,force:true});});
  const actor = service.store.ensureAdmin('registry@example.test');
  const call = (node,method,data)=>service.controller.call(actor.id,{node,method,data,timeoutMs:3000});
  const settingsSchema={type:'object',properties:{prefix:{type:'string'}},required:['prefix'],additionalProperties:false};
  await call('~','$.runners.add',{name:'prepend',entrypoint,settingsSchema});
  const runners = await call('~','$.runners.get',{});
  assert.deepEqual(runners.find(entry=>entry.name==='prepend').settingsSchema,settingsSchema);
  const source = prefix=>({manifest:{run:{type:'prepend',settings:{prefix,features:{
    format:{type:'method',version:'1',description:'prepend a prefix',schema:{input:{type:'string'}}}}}},
    executors:{mode:'oneShot'}}});
  const {id}=await call('~','$.app.create',{name:'formatter',permissions:[],source:source('test:')});
  await assert.rejects(call(id,'$.app.manifest.set',{source:source(17)}),/registered runner schema/);
  assert.equal(service.controller.help(actor.id,{node:id}).versions.format,'1');
  await call(id,'$.app.start',{});
  assert.deepEqual(await call(id,'format','hello'),{text:'test:hello',command:false,cwd:false,holdFirst:false});
});
