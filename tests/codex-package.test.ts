import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createService } from '../src/server.ts';

test('installed Codex package imports an authorized profile and handles typed work through the controller', {
  skip: !(process.env.PAPPAI_TEST_CODEX_ENTRYPOINT && process.env.PAPPAI_TEST_CODEX_CLI && process.platform==='linux'),
  timeout:60_000,
}, async t => {
  const base='/run/pappai/private';
  await mkdir(base,{recursive:true,mode:0o700});
  const root=await mkdtemp(join(base,'pappai-integration-'));
  const source=await mkdtemp('/tmp/pappai-profile-source-');
  const authFile=join(source,'auth.json');
  const apiKey='synthetic-e2e-only';
  const turns:string[]=[];
  const workspaceResults = new Map<string,string>();
  let toolTarget = '', offeredTools:string[] = [];
  let persistentApp = '';
  const waitingForInterrupt = Promise.withResolvers<void>();
  await writeFile(authFile,JSON.stringify({OPENAI_API_KEY:apiKey}),{mode:0o600});
  t.after(async()=>{await rm(root,{recursive:true,force:true});await rm(source,{recursive:true,force:true});});
  const model=createServer(async(req,res)=>{
    if (req.url!=='/v1/responses' || req.headers.authorization!=='Bearer '+apiKey) { res.writeHead(401).end();return; }
    const body:Buffer[]=[];
    for await (const chunk of req) body.push(chunk);
    const request=JSON.parse(Buffer.concat(body).toString());
    turns.push(JSON.stringify(request.input));
    if (turns.at(-1)!.includes('HOLD-UNTIL-INTERRUPTED')) {
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_hold"}}\n\n');
      waitingForInterrupt.resolve();
      return;
    }
    const text=JSON.stringify({result:turns.length});
    const msg={type:'message',id:'msg_'+turns.length,role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]};
    const id='resp_'+turns.length;
    const toolTurn = turns.length === 4 && turns[3].includes('CHECK-WORKSPACE-TOOLS');
    const tools = [
      {name:'pappai_call',args:{node:toolTarget,method:'$.app.get',data:{}}},
      {name:'pappai_call',args:{node:toolTarget,method:'$.app.executors.get',data:{}}},
      {name:'pappai_discover',args:{}},
      {name:'pappai_help',args:{node:toolTarget,features:'$.app',description:false}},
    ];
    const items = toolTurn ? tools.map(({name,args},index)=>({
      type:'function_call',name,call_id:'workspace_'+index,id:'fc_'+index,status:'completed',
      arguments:JSON.stringify(args),
    })) : [msg];
    if (toolTurn) offeredTools=request.tools.map((tool:{name:string})=>tool.name);
    for (const item of request.input) if (item.type==='function_call_output') workspaceResults.set(item.call_id,JSON.stringify(item.output));
    const events=[{type:'response.created',response:{id}},
      ...items.map((item,output_index)=>({type:'response.output_item.done',output_index,item})),
      {type:'response.completed',response:{id,usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}];
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(events.map(e=>'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n').join(''));
  });
  model.listen(0,'127.0.0.1');
  await once(model,'listening');
  t.after(()=>{model.closeAllConnections();model.close();});
  const port=(model.address() as {port:number}).port;
  const db=new DatabaseSync(':memory:');
  const runnerRoot=join(root,'runners');
  const service=createService({db,origin:'http://localhost',runnerRoot});
  t.after(async()=>{await service.close();db.close();});
  const admin=service.store.ensureAdmin('operator@example.test');
  const call=(node:string,method:string,data:unknown={})=>service.controller.call(admin.id,{node,method,data,timeoutMs:15000});
  const profilesDir=join(root,'profiles');
  await mkdir(profilesDir,{mode:0o700});
  const config={codexExecutablePath:process.env.PAPPAI_TEST_CODEX_CLI,profilesDir,stateDir:join(root,'state'),
    modelBaseUrl:'http://127.0.0.1:'+port+'/v1'};
  const entrypoint=join(runnerRoot,'codex','fixture.mjs');
  await mkdir(join(runnerRoot,'codex'),{recursive:true,mode:0o700});
  await writeFile(entrypoint,'process.env.PAPPAI_RUNNER_CONFIG = '+JSON.stringify(JSON.stringify(config))+
    ';\nawait import('+JSON.stringify(pathToFileURL(process.env.PAPPAI_TEST_CODEX_ENTRYPOINT!).href)+');\n');
  await call('~','$.runners.add',{name:'codex',entrypoint});
  const {id:profile}=await call('~','$.profile.create',{name:'test profile',permissions:[]});
  assert.deepEqual(await call(profile,'codex.setup',{authFile}),{configured:true});
  for (const mode of ['oneShot','persistent']) {
    const {id:app}=await call('~','$.app.create',{name:mode,profile,permissions:[],source:{manifest:{
      executors:{mode},run:{type:'codex',settings:{model:'gpt-5.4',features:{
        'agent.execute':{type:'method',description:'Count turns',version:'1',schema:{output:{type:'integer'}}},
        ...(mode==='persistent' && {
          'agent.getHistory':{type:'method',description:'Read conversation messages',version:'1'},
          'agent.interrupt':{type:'method',description:'Interrupt the running turn',version:'1'},
        })}}}}}});
    await call(profile,'$.profile.scope.set',{scope:[app]});
    await call(profile,'$.profile.enable');
    await call(app,'$.app.start');
    assert.equal(await call(app,'agent.execute',{input:'first '+mode}),turns.length);
    if (mode==='persistent') {
      persistentApp=app;
      await call(app,'$.app.restart');
      assert.equal(await call(app,'agent.execute',{input:'continue'}),3);
      assert.ok(turns[2].includes('first persistent'));
      assert.ok(!turns[2].includes('first oneShot'));
      const {messages}=await call(app,'agent.getHistory');
      assert.ok(messages.some((item:{role:string,text:string})=>item.role==='user' && item.text.includes('first persistent')));
      assert.ok(messages.some((item:{role:string,text:string})=>item.role==='assistant' && item.text.includes('"result":2')));
    }
  }
  assert.equal(turns.length,3);
  const createApp = (name:string,permissions:unknown[])=>call('~','$.app.create',{name,profile,permissions,source:{manifest:{
    executors:{mode:'oneShot'},run:{type:'codex',settings:{model:'gpt-5.4',features:{
      execute:{type:'method',description:'Check visible workspace state',version:'1',schema:{output:{type:'integer'}}}}}}}}});
  toolTarget=(await createApp('inspectee',[])).id;
  const {id:inspector}=await createApp('inspector',[{node:toolTarget,methods:'$.app.get',discover:true}]);
  await call(profile,'$.profile.scope.set',{scope:[inspector]});
  await call(inspector,'$.app.start');
  assert.equal(await call(inspector,'execute',{input:'CHECK-WORKSPACE-TOOLS'}),5);
  assert.ok(['pappai_discover','pappai_help','pappai_call','pappai_publish'].every(name=>offeredTools.includes(name)));
  assert.match(workspaceResults.get('workspace_0') ?? '',/stopped/);
  assert.match(workspaceResults.get('workspace_1') ?? '',/Permission denied/);
  assert.match(workspaceResults.get('workspace_2') ?? '',/inspectee/);
  assert.match(workspaceResults.get('workspace_3') ?? '',/provides/);
  await call(profile,'$.profile.scope.set',{scope:[persistentApp]});
  await call(persistentApp,'$.app.start');
  const interrupted=assert.rejects(call(persistentApp,'agent.execute',{input:'HOLD-UNTIL-INTERRUPTED'}),/interrupted/);
  await waitingForInterrupt.promise;
  assert.deepEqual(await call(persistentApp,'agent.interrupt'),{interrupted:true});
  await interrupted;
  assert.equal(turns.length,6);
  assert.deepEqual(await call(profile,'codex.remove'),{configured:false});
});
