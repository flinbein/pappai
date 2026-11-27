import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
import { Store } from '../src/store.ts';
import { Controller } from '../src/controller.ts';
import { attachEvents } from '../src/events.ts';

async function fixture(t) {
  const db=new DatabaseSync(':memory:');
  const store=new Store(db);
  const actor=store.ensureAdmin('events@example.test').id;
  const runner=Object.assign(new EventEmitter(),{jobs:[],dispatch(job){this.jobs.push(job);},stop(){},rejectReply(){},deliver(){}});
  const controller=new Controller(store,runner);
  const server=createServer();
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const address=new URL('http://127.0.0.1:'+server.address().port);
  let signedIn=true;
  let touches=0;
  const events=attachEvents(server,address,store,(req,touch=true)=>{
    if (!signedIn || req.headers.cookie !== 'session=test') return null;
    if (touch) touches++;
    return actor;
  },controller);
  t.after(async()=>{
    events.close();controller.shutdown();
    await new Promise(resolve=>server.close(resolve));
    db.close();
  });
  const connect=async(path='/api/ws/web')=>{
    const ws=new WebSocket('ws://'+address.host+path,{origin:address.origin,headers:{cookie:'session=test'}});
    const pending=new Map();
    const received=[];
    const messages=[];
    let id=0;
    ws.on('message',bytes=>{
      const message=JSON.parse(bytes.toString());
      messages.push(message);
      if (message.id) {pending.get(message.id)?.(message);pending.delete(message.id);}
      else received.push(message);
    });
    await once(ws,'open');
    const rpc=(method,params={})=>new Promise(resolve=>{
      pending.set(++id,resolve);
      ws.send(JSON.stringify({jsonrpc:'2.0',id,method,params}));
    });
    return {ws,rpc,received,messages};
  };
  return {store,actor,controller,runner,connect,address,touches:()=>touches,logout(){signedIn=false;events.checkSessions();}};
}

test('USER subscriptions belong to a single WebSocket and expire with the authenticated session',async t=>{
  const {actor,connect,logout,address}=await fixture(t);
  const a=await connect('/ws/events'), b=await connect();
  assert.ok((await a.rpc('discover')).result.some(node => node.id === actor));
  const help = await a.rpc('help',{node:'~',features:'$.workspace',description:false});
  assert.deepEqual(help.result['$.workspace'],{type:'document',version:'1',provides:{events:1}});
  for (const [headers,status] of [
    [{origin:'https://other.example',cookie:'session=test'},403],
    [{origin:address.origin,host:'other.example',cookie:'session=test'},403],
    [{origin:address.origin},401],
  ]) {
    const rejected=new WebSocket('ws://'+address.host+'/api/ws/web',{headers});
    assert.match((await once(rejected,'error'))[0].message,new RegExp(String(status)));
  }
  const add={subscriptions:[{id:'ui',node:actor,events:'chat.message'}]};
  assert.deepEqual((await a.rpc('subscriptions.add',add)).result,{});
  assert.ok((await a.rpc('subscriptions.add',add)).error);
  assert.deepEqual((await a.rpc('subscriptions.disable',{ids:['ui']})).result,{});
  assert.equal((await a.rpc('subscriptions.get')).result.subscriptions[0].enabled,false);
  assert.deepEqual((await a.rpc('subscriptions.enable',{ids:['ui']})).result,{});
  const report=await b.rpc('publish',{event:'chat.message',data:'hello',delivery:'status',to:actor});
  assert.deepEqual(report.result.deliveries,[{node:actor,status:'delivered'}]);
  await a.rpc('subscriptions.get');
  assert.deepEqual(a.received[0].params,{from:actor,event:'chat.message',subscription:'ui',data:'hello'});
  assert.deepEqual(b.received,[]);
  const close=Promise.all([once(a.ws,'close'),once(b.ws,'close')]);
  logout();
  const [,canonicalClose]=await close;
  assert.equal(canonicalClose[0],4401);
});

test('restricted TEAM publication delivers ordinary events and filters reported recipients',async t=>{
  const {store,actor,controller,connect}=await fixture(t);
  const team=store.create('~','team',{name:'publisher',permissions:null}).id;
  const {rpc,received}=await connect();
  await rpc('subscriptions.add',{subscriptions:[{id:'team',node:team,events:'ordinary'}]});
  const report=await controller.publish(team,{event:'ordinary',to:actor,delivery:'status',permissions:[]});
  await rpc('subscriptions.get');
  assert.deepEqual(report.deliveries,[]);
  assert.equal(received.length,1);
  assert.equal(received[0].params.from,team);
  assert.throws(()=>controller.publish(team,{event:'$.node.created'}),/publication/);
});

test('subscriptions apply in frame order and overlapping matches produce one event before the call response',async t=>{
  const {connect,controller,touches}=await fixture(t);
  const {rpc,messages,received,ws}=await connect();
  assert.equal(touches(),0);
  const subscribe=rpc('subscriptions.set',{subscriptions:[
    {id:'tree',events:'$.node.created'},
    {id:'all',node:true},
    {id:'nested',node:['~/**'],events:['$.node.*','$.lifecycle.statusChanged']},
    {id:'except-root',node:['!~',true]},
    {id:'except-descendants',node:['!~/**',true]},
    {id:'none',node:false},
    {id:'other',node:'~'},
  ]});
  const create=rpc('call',{node:'~',method:'$.children.createTeam',data:{name:'Frame order'}});
  const [subscribed,created]=await Promise.all([subscribe,create]);
  assert.deepEqual(subscribed.result,{});
  const event={jsonrpc:'2.0',method:'event',params:{from:created.result.id,event:'$.node.created',
    data:{status:'working'},subscriptionIds:['tree','all','nested','except-root']}};
  const invalidated=messages[2];
  assert.equal(invalidated.params.event,'$.effectivePermissions.invalidated');
  assert.deepEqual(invalidated.params.subscriptionIds,['all','except-root']);
  assert.deepEqual(messages,[subscribed,event,invalidated,created]);
  assert.equal(touches(),2);
  const passive=once(ws,'message');
  controller.emitSystem(created.result.id,'$.node.created',{status:'working'});
  await passive;
  assert.equal(touches(),2,'delivery does not extend session idle expiry');
  assert.deepEqual(received,[event,invalidated,event]);
  const permissions=[{events:Array(5000).fill('long.message.name')}];
  assert.deepEqual((await rpc('call',{node:created.result.id,method:'$.permissions.set',data:{permissions}})).result,{});
  assert.deepEqual((await rpc('call',{node:created.result.id,method:'$.permissions.get'})).result,{permissions});
});

test('web subscription mutations validate filters atomically and disconnect drops subscriptions',async t=>{
  const {connect}=await fixture(t);
  const {rpc,ws}=await connect();
  const subscriptions=[{id:'watch'}];
  await rpc('subscriptions.add',{subscriptions});
  for (const invalid of [
    {id:'a',node:[5]},{id:'a',events:false},{id:'a',events:[true]},
    {id:'a',node:['~','!~']},{id:'a',events:{example:true}},{id:'a',enabled:true},{id:'watch'},
  ]) assert.ok((await rpc('subscriptions.add',{subscriptions:[invalid]})).error);
  for (const action of ['enable','disable','unknown'])
    assert.ok((await rpc('subscriptions.'+action,{ids:['watch']})).error);
  assert.deepEqual((await rpc('subscriptions.get')).result,{subscriptions});
  assert.deepEqual((await rpc('subscriptions.delete',{ids:['watch']})).result,{});
  assert.deepEqual((await rpc('subscriptions.get')).result,{subscriptions:[]});
  await rpc('subscriptions.add',{subscriptions});
  const closed=once(ws,'close');
  ws.close();await closed;
  assert.deepEqual((await (await connect()).rpc('subscriptions.get')).result,{subscriptions:[]});
});

test('web calls serialize void results and abort pending work on cancel or session revocation',async t=>{
  const {connect,controller,store,logout}=await fixture(t);
  const profile=store.create('~','profile',{name:'Test profile'}).id;
  const {rpc,ws}=await connect();
  const started=[];
  controller.hooks.profileCall=async (_actor,_profile,method,_data,_worker,signal)=>{
    if (method==='empty') return;
    started.push(signal);
    await once(signal,'abort');
    throw Error('Call cancelled');
  };
  assert.deepEqual(await rpc('call',{node:profile,method:'empty'}),{jsonrpc:'2.0',id:1,result:null});
  const first=rpc('call',{node:profile,method:'wait'});
  assert.deepEqual((await rpc('cancel',{id:2})).result,{});
  assert.match((await first).error.message,/cancelled/);
  void rpc('call',{node:profile,method:'wait'});
  await rpc('subscriptions.get');
  assert.equal(started[1].aborted,false);
  const closed=once(ws,'close');
  logout();
  assert.equal(started[1].aborted,true);
  await closed;
});

test('broad subscriptions continue to obey current receive and call permissions',async t=>{
  const {actor,connect,controller,store}=await fixture(t);
  const {rpc,received}=await connect();
  assert.deepEqual((await rpc('subscriptions.add',{subscriptions:[{id:'all'}]})).result,{});
  store.manage(actor,actor,'$.permissions.set',{permissions:[]});
  controller.emitSystem('~','$.workspace.init',{});
  assert.match((await rpc('call',{node:'~',method:'$.children.createTeam',data:{name:'Denied'}})).error.message,/permission/i);
  assert.deepEqual(received,[]);
});

test('only observable recipients affect publisher reports, and timeouts leave queued events deliverable',async t=>{
  const {actor,store,controller,runner,connect}=await fixture(t);
  const connectUser=await connect();
  const manifest={run:{type:'process',settings:{command:'node',cwd:process.cwd(),features:{}}},executors:{mode:'oneShot'},subscriptions:[{events:'probe'}]};
  const recipient=store.create('~','app',{name:'receiver',permissions:null,manifest}).id;
  store.setStatus(recipient,'working');
  const notification = new Promise(resolve=>{
    const read=raw=>{
      const message=JSON.parse(raw.toString());
      if (message.method !== 'delivery') return;
      connectUser.ws.off('message',read);
      resolve(message.params);
    };
    connectUser.ws.on('message',read);
  });
  const report=await connectUser.rpc('publish',{event:'probe',data:1,to:recipient,delivery:'track',timeoutMs:20});
  assert.deepEqual(report.result.deliveries,[{node:recipient,status:'queued'}]);
  assert.deepEqual(await notification,{publication:report.result.publication,node:recipient,status:'timeout'});
  const first=runner.jobs[0];
  runner.emit('started',first);
  runner.emit('written',{appId:recipient,workerId:first.id,id:first.id});
  runner.emit('exit',first);
  const hidden=store.create('~','user',{name:'hidden',email:'hidden@example.test',permissions:[]}).id;
  store.setStatus(hidden,'working');
  const undisclosed=await controller.publish(hidden,{event:'probe',data:2,to:recipient,delivery:'track',timeoutMs:5000});
  assert.deepEqual(undisclosed.deliveries,[]);
  const final=controller.publish(actor,{event:'probe',data:3,to:recipient,delivery:'track',timeoutMs:1000});
  runner.emit('exit',runner.jobs[1]);
  const third=runner.jobs[2];
  runner.emit('started',third);
  runner.emit('written',{appId:recipient,workerId:third.id,id:third.id});
  assert.deepEqual((await final).deliveries,[{node:recipient,status:'delivered'}]);
});
