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
  const events=attachEvents(server,address,store,req=>signedIn && req.headers.cookie==='session=test' ? actor : null,controller);
  const clients=[];
  t.after(async()=>{
    events.close();controller.shutdown();
    await new Promise(resolve=>server.close(resolve));
    db.close();
  });
  const connect=async()=>{
    const ws=new WebSocket('ws://'+address.host+'/ws/events',{origin:address.origin,headers:{cookie:'session=test'}});
    clients.push(ws);
    const pending=new Map();
    const received=[];
    let id=0;
    ws.on('message',bytes=>{
      const message=JSON.parse(bytes.toString());
      if (message.id) {pending.get(message.id)?.(message);pending.delete(message.id);}
      else received.push(message);
    });
    await once(ws,'open');
    const rpc=(method,params={})=>new Promise(resolve=>{
      pending.set(++id,resolve);
      ws.send(JSON.stringify({jsonrpc:'2.0',id,method,params}));
    });
    return {ws,rpc,received};
  };
  return {store,actor,controller,runner,connect,address,logout(){signedIn=false;events.checkSessions();}};
}

test('USER subscriptions belong to a single WebSocket and expire with the authenticated session',async t=>{
  const {actor,connect,logout,address}=await fixture(t);
  const a=await connect(), b=await connect();
  const rejected=new WebSocket('ws://'+address.host+'/ws/events',{origin:'https://other.example',headers:{cookie:'session=test'}});
  assert.match((await once(rejected,'error'))[0].message,/403/);
  const add={subscriptions:[{id:'ui',node:actor,events:'chat.message'}]};
  assert.deepEqual((await a.rpc('subscriptions.add',add)).result,{});
  assert.ok((await a.rpc('subscriptions.add',add)).error);
  const report=await b.rpc('publish',{event:'chat.message',data:'hello',delivery:'status',to:actor});
  assert.deepEqual(report.result.deliveries,[{node:actor,status:'delivered'}]);
  await a.rpc('subscriptions.get');
  assert.deepEqual(a.received[0].params,{from:actor,event:'chat.message',subscription:'ui',data:'hello'});
  assert.deepEqual(b.received,[]);
  const close=Promise.all([once(a.ws,'close'),once(b.ws,'close')]);
  logout();await close;
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
