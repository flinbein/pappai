import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createService } from '../src/server.ts';
import { cliLaunchPlan } from '../src/runner-installation.ts';

test('PROFILE CLI discovery, separate permits and interactive credential import', {timeout:30_000}, async t=>{
  const root=mkdtempSync(join(tmpdir(),'pappai-profile-cli-'));
  const directory=join(root,'fixture');
  mkdirSync(directory);
  const entrypoint=join(directory,'runner.cjs');
  const helper=join(directory,'authorize.sh');
  writeFileSync(helper,[
    'set -eu',
    'test -t 0 && test ! -e /opt/pappai/src && test ! -e /run/pappai/private',
    'printf synthetic > "$PAPPAI_CLI_TMP/auth.json"',
    'pappai call "$1" fixture.setup "{\\"authFile\\":\\"$PAPPAI_CLI_TMP/auth.json\\"}"',
  ].join('\n'));
  const schema={type:'object',additionalProperties:false};
  const declaration={description:'Authorize fixture',version:'2',doc:'Interactive setup.',schema:{input:schema}};
  writeFileSync(entrypoint,`
    process.on('message',msg=>{
      const send=(type,fields)=>process.send({type,payload:{id:msg.id,...fields}});
      if(msg.type==='close') process.disconnect();
      if(msg.type==='runnerCall' && msg.method==='@cli.prepare')
        send('runnerReply',{result:{files:[require('node:path').join(__dirname,'authorize.sh')],argv:['/bin/sh','/run/pappai/cli/0',msg.data.node]}});
      if(msg.type==='profileCall') send('profileRead',{requestId:'read',path:msg.data.authFile});
      if(msg.type==='profileFile') send('profileReply',msg.error ? {error:msg.error} : {result:{configured:Buffer.from(msg.content,'base64').toString()==='synthetic'}});
    });
    process.send({type:'profileMethods',payload:{methods:['setup']}});
    process.send({type:'runnerReady',payload:{profileCli:{authorize:${JSON.stringify(declaration)}}}});
  `);
  const db=new DatabaseSync(':memory:');
  const origin='http://localhost';
  const service=createService({db,origin,runnerRoot:root});
  t.after(async()=>{await service.close();db.close();rmSync(root,{recursive:true,force:true});});
  const {store,runner,controller}=service;
  const admin=store.ensureAdmin('owner@example.test');
  const profile=store.create('~','profile',{name:'CLI test'}).id;
  await controller.call(admin.id,{node:'~',method:'$.runners.add',data:{name:'fixture',entrypoint}});
  const cli='fixture.authorize';
  const help=controller.help(admin.id,{node:profile,features:cli,doc:true,schema:true});
  assert.deepEqual(help[cli],{type:'cli',...declaration});
  await assert.rejects(controller.call(admin.id,{node:profile,method:cli,data:{}}),/unavailable/);
  const user=store.create('~','user',{name:'Operator',email:'operator@example.test',permissions:[{node:profile,methods:true}]}).id;
  store.setStatus(user,'working');
  await assert.rejects(runner.prepareCli(user,profile,cli,{}),/Permission denied/);
  await controller.call(admin.id,{node:user,method:'$.permissions.set',data:{permissions:[
    {node:profile,cli:{[cli]:schema},methods:'fixture.setup'},
  ]}});
  const plan=await runner.prepareCli(user,profile,cli,{});
  assert.deepEqual(plan.files,[helper]);
  await assert.rejects(runner.prepareCli(user,profile,cli,{env:{KEY:'x'}}),/Permission denied/);
  await assert.rejects(runner.prepareCli(admin.id,profile,cli,{env:{KEY:'x'}}),/schema/);
  assert.throws(()=>cliLaunchPlan(root,'fixture',{files:[root],argv:['/bin/sh']}),/file in the named/);
  if (process.env.PAPPAI_TEST_BWRAP==='1') {
    await service.enableAdminCli();
    const exec=promisify(execFile);
    const cliResult=async (...args:string[])=>JSON.parse((await exec('pappai',args)).stdout);
    assert.deepEqual(await cliResult('me'),{id:'~',parentId:null,type:'workspace',name:'workspace'});
    assert.deepEqual(await cliResult('-u',user,'me'),{id:user,parentId:'~',type:'user',name:'Operator'});
    assert.ok((await cliResult('discover')).some((entry:any)=>entry.id===profile));
    assert.ok((await cliResult('help','~'))['$.runners']);
    assert.deepEqual(await cliResult('call',user,'$.node.get'),await controller.call(admin.id,{node:user,method:'$.node.get'}));
    await assert.rejects(cliResult('-u',user,'call','~','$.runners.list'),/Permission denied/);
    await assert.rejects(cliResult('-u',profile,'me'),/active USER or APP/);
    const testApp=store.create('~','app',{name:'Impersonation fixture',manifest:{
      run:{type:'process',settings:{command:'/bin/true',cwd:'/tmp',features:{}}},executors:{mode:'oneShot'},
    }}).id;
    await assert.rejects(cliResult('-u',testApp,'me'),/active USER or APP/);
    store.setStatus(testApp,'working');
    assert.equal((await cliResult('-u',testApp,'me')).id,testApp);
    assert.match((await exec('pappai',['cli',profile,cli])).stdout,/"configured":\s*true/);
    await assert.rejects(exec('pappai',['me'],{uid:65534,gid:65534}),/Permission denied|EPERM|EACCES/);
    // Isolated fixture session. Exercise the same WebSocket and broker as both UI launch paths.
    db.prepare('INSERT INTO passkeys VALUES(?,?,?,0)').run('test-key',user,Buffer.alloc(1));
    const expiry=Date.now()+60_000;
    db.prepare('INSERT INTO web_sessions VALUES(?,?,?,?)').run(createHash('sha256').update('fixture').digest('hex'),'test-key',expiry,expiry);
    service.server.listen(0,'127.0.0.1');
    await once(service.server,'listening');
    const {port}=service.server.address() as {port:number};
    for (const launch of [{cli:{node:profile,method:cli,input:{}}},{argv:['pappai','cli',profile,cli,'{}']},{argv:['pappai','me']}]) {
      const ws=new WebSocket('ws://127.0.0.1:'+port+'/api/ws/terminal?start=manual',
        {headers:{origin,host:'localhost',cookie:'pappai-local-session=fixture'}});
      let output='',exitCode;
      ws.on('message',(raw,binary)=>{
        if(binary) { output+=raw.toString(); ws.send(JSON.stringify({rendered:raw.length})); }
        else { const frame=JSON.parse(raw.toString()); if(frame.error) output+=frame.error; exitCode=frame.exitCode; }
      });
      const end=once(ws,'close');
      await once(ws,'open');
      ws.send(JSON.stringify({...launch,cols:80,rows:24}));
      assert.equal((await end)[0],1000,output);
      assert.equal(exitCode,0,output);
      if (launch.argv?.[1]==='me') assert.deepEqual(JSON.parse(output),await cliResult('-u',user,'me'));
      else assert.match(output,/"configured":\s*true/);
    }
  }
  await controller.call(admin.id,{node:'~',method:'$.runners.disable',data:{name:'fixture'}});
  assert.equal(controller.help(admin.id,{node:profile,features:cli})[cli],undefined);
  await assert.rejects(runner.prepareCli(admin.id,profile,cli,{}),/unavailable/);
});
