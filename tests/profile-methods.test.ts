import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { ProfileMethods } from '../src/profile-methods.ts';

class Host extends EventEmitter {
  messages:any[]=[];
  profileSend(msg:object) { this.messages.push(msg); }
}

test('profile file reads and replies are bound to their assigned host and caller', async () => {
  const hosts = [new Host(),new Host()];
  const broker = new ProfileMethods();
  for (const [i, host] of hosts.entries()) {
    broker.attach(i === 0 ? 'codex':'other', host);
    host.emit('profileMethods',{methods:['setup']});
  }
  assert.deepEqual(broker.names(),['codex.setup','other.setup']);
  broker.reader=(actor,path,worker)=>{assert.deepEqual([actor,path,worker],['alice','/tmp/auth','w']);return Buffer.from('synthetic');};
  const pending=broker.call('alice','p','codex.setup',{},'w');
  const [{id}] = hosts[0].messages;
  for (const host of hosts) host.emit('profileRead',{id,path:'/tmp/auth',requestId:'req'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(hosts[1].messages.length,0);
  assert.equal(hosts[0].messages[1].content,Buffer.from('synthetic').toString('base64'));
  hosts[1].emit('profileReply',{id,result:'wrong'});
  hosts[0].emit('profileReply',{id,result:'ok'});
  assert.equal(await pending,'ok');
  hosts[0].emit('profileRead',{id,path:'/tmp/auth',requestId:'req2'});
  assert.equal(hosts[0].messages.length,2);
  await assert.rejects(broker.call('alice','p','codex.unknown',{}),/unavailable/i);
});

test('retiring a host rejects its pending profile call and removes advertised methods', async () => {
  const host=new Host(), broker=new ProfileMethods();
  broker.attach('codex',host);
  host.emit('profileMethods',{methods:['setup']});
  const call=broker.call('a','p','codex.setup',{});
  broker.detach(host);
  await assert.rejects(call,/unavailable/i);
  assert.deepEqual(broker.names(),[]);
});

test('cancelled and expired profile calls cannot read files afterward', async ()=>{
  const host=new Host(), broker=new ProfileMethods();
  broker.attach('codex',host);
  host.emit('profileMethods',{methods:['setup']});
  let reads=0;
  broker.reader=()=>{reads++;return Buffer.from('bytes');};
  const abort=new AbortController();
  const cancelled=broker.call('user','p','codex.setup',{},undefined,abort.signal,1000);
  abort.abort();
  const timeout=broker.call('user','p','codex.setup',{},undefined,undefined,1);
  const [cancelledId,expiredId]=host.messages.map(msg=>msg.id);
  // A late runner response must never turn cancellation into a success.
  host.emit('profileReply',{id:cancelledId,result:'late'});
  await assert.rejects(cancelled,/cancel/i);
  const keepAlive=setTimeout(()=>{},500);
  try { await assert.rejects(timeout,/timed out/i); } finally {clearTimeout(keepAlive);}
  for (const id of [cancelledId,expiredId]) host.emit('profileRead',{id,requestId:'r',path:'/tmp/file'});
  assert.equal(reads,0);
});

test('cold-start calls wait only for the named runner advertisement and cancelled calls never reach it', async ()=>{
  const host=new Host(), other=new Host(), broker=new ProfileMethods();
  broker.attach('codex',host);
  broker.attach('other',other);
  const abort=new AbortController();
  const cancelled=broker.call('user','p','codex.setup',{},undefined,abort.signal);
  const ready=broker.call('user','p','codex.setup',{input:1});
  const missing=broker.call('user','p','codex.unknown',{});
  other.emit('profileMethods',{methods:['setup']});
  assert.deepEqual(host.messages,[]);
  abort.abort();
  await assert.rejects(cancelled,/cancel/i);
  host.emit('profileMethods',{methods:['setup']});
  await assert.rejects(missing,/unavailable/i);
  assert.equal(host.messages.length,1);
  assert.deepEqual(host.messages[0].data,{input:1});
  host.emit('profileReply',{id:host.messages[0].id,result:'ready'});
  assert.equal(await ready,'ready');
});
