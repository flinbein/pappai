import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileDelegations } from '../src/file-delegations.ts';
import { Controller } from '../src/controller.ts';
import { Store } from '../src/store.ts';
import { sandboxPrivateTmp } from '../src/sandbox.ts';

const linux = {skip:process.platform !== 'linux'};
function stream(socketPath: string, key: string, method: string, data?: Buffer) {
  return new Promise<{status: number; body:Buffer}>((resolve, reject) => {
    const req = request({socketPath, path:'/' + key, method, agent:false}, res => {
      const chunks:Buffer[] = [];
      res.on('data', part => chunks.push(part));
      res.on('end', () => resolve({status:res.statusCode!, body:Buffer.concat(chunks)}));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(data);
  });
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pappai-delegation-test-'));
  const allowed = new Set<string>(['caller','target']);
  const service = new FileDelegations({
    fileSnapshot: actor => ({sandbox:null,
      allows: path => allowed.has(actor) && (path === dir || path.startsWith(dir + '/'))}),
  });
  const socket = service.socketFor('worker')!;
  t.after(() => {
    service.executorExit('worker');
    service.executorExit('other');
    rmSync(dir,{recursive:true,force:true});
  });
  const start = grants => {
    service.callOpened('active','caller','target',grants);
    service.callAssigned('active','worker');
  };
  const rpc = (method, params) => service.executorRequest('worker','target',method,{callId:'active',...params});
  const open = async (path,mode) => (await rpc('files.open',{path,mode})).handle;
  return {dir,service,allowed,socket,start,open,rpc};
}

test('file grants enforce namespace, current caller rights, modes and exclusive creation',linux,async t => {
  const {dir,service,allowed,socket,start,open} = fixture(t);
  const file = join(dir,'result');
  const nested = join(dir,'nested');
  mkdirSync(nested);
  assert.throws(() => start({read:['../relative']}), /path/);
  start({write:[file], create:[nested + '/']});
  await assert.rejects(open(file,'read'), /denied/);
  await assert.rejects(open(nested + '-prefix/escape','create'), /denied/);
  const name = join(nested,'new');
  const results = await Promise.allSettled([open(name,'create'),open(name,'create')]);
  assert.deepEqual(results.map(r => r.status), ['fulfilled','rejected']);
  assert.match(results[1].reason.message,/EEXIST/);
  assert.equal(service.unfinished('active'), true);
  assert.equal((await stream(service.socketFor('other')!,results[0].value,'PUT')).status,403);
  assert.equal((await stream(socket,results[0].value,'PUT',Buffer.from('ok'))).status,200);
  assert.equal(service.unfinished('active'), false);
  assert.equal(readFileSync(name,'utf8'),'ok');
  writeFileSync(file,'abcdef');
  const handle = await open(file,'write');
  assert.equal(readFileSync(file,'utf8'),'abcdef');
  const result = await stream(socket,handle,'PUT',Buffer.from('OK'));
  assert.deepEqual(JSON.parse(result.body.toString()),{bytesWritten:2});
  assert.equal(readFileSync(file,'utf8'),'OKcdef');
  allowed.delete('caller');
  await assert.rejects(open(file,'write'),/denied/);
});

test('file copy reads and replaces one file, rejects symlinks and revokes handles',linux,async t => {
  const {dir,service,socket,start,open,rpc} = fixture(t);
  const src = join(dir,'source'), dst = join(dir,'dest');
  const bytes = Buffer.from([0,255,1,254]);
  writeFileSync(src,bytes);
  writeFileSync(dst,'preexisting longer output');
  start({read:[dir + '/'],write:[dst],create:[dir + '/']});
  assert.deepEqual(await rpc('files.copy',{from:{caller:src},to:{self:dst}}),{bytesCopied:bytes.length});
  assert.deepEqual(readFileSync(dst),bytes);
  const newFile = join(dir, 'new');
  await rpc('files.copy',{from:{self:src},to:{caller:newFile}});
  await assert.rejects(rpc('files.copy',{from:{self:src},to:{caller:newFile}}),/EEXIST/);
  assert.deepEqual((await stream(socket,await open(newFile,'read'),'GET')).body, bytes);
  await assert.rejects(rpc('files.copy',{from:{self:dst},to:{caller:dst}}),/Same/);
  assert.deepEqual(readFileSync(dst),bytes);
  symlinkSync(src, join(dir,'link'));
  symlinkSync(dir, join(dir,'linkdir'));
  await assert.rejects(open(join(dir,'link'),'read'), /ordinary/);
  await assert.rejects(open(join(dir,'linkdir','source'),'read'), /ENOTDIR|ELOOP/);
  const key = await open(src,'read');
  await assert.rejects(service.executorRequest('other','target','files.open',
    {callId:'active',path:src,mode:'read'}), /denied/);
  service.callClosed('active');
  assert.equal((await stream(socket,key,'GET')).status,403);
  await assert.rejects(open(src,'read'), /denied/);
});

test('revocation closes an active upload and an incomplete HTTP body cannot complete it',linux,async t => {
  const {dir,service,socket,start,open} = fixture(t);
  const file = join(dir,'upload');
  start({create:[file]});
  const key = await open(file,'create');
  const req = request({socketPath:socket, path:'/' + key, method:'PUT', agent:false,
    headers:{'Content-Length':'100'}});
  const closed = new Promise<void>(resolve => req.once('close',resolve));
  req.on('error',()=>{});
  req.write('prefix');
  // Probe the bound handle until the first chunk has actually reached disk.
  for (let i = 0; i < 100 && !readFileSync(file).length; i++)
    await new Promise(resolve => setTimeout(resolve,5));
  assert.equal(readFileSync(file,'utf8'),'prefix');
  assert.equal(service.unfinished('active'),true);
  service.callClosed('active');
  await closed;
  assert.equal(readFileSync(file,'utf8'),'prefix');
  assert.equal((await stream(socket,key,'PUT')).status,403);
});

test('an existing executor keeps its own tmp and cannot acquire newly granted mount paths',linux,async t => {
  const root=mkdtempSync('/var/tmp/pappai-generation-');
  const actor='actor-'+root.split('-').at(-1);
  const privateDir=sandboxPrivateTmp(actor);
  const extra=join(root,'later');
  writeFileSync(extra,'later grant');
  writeFileSync(join(privateDir,'old-tmp'),'private bytes');
  let limited=true;
  const service=new FileDelegations({
    fileSnapshot:()=>limited
      ? {sandbox:{read:[],write:[],network:false},allows:path=>path==='/tmp' || path.startsWith('/tmp/')}
      : {sandbox:null,allows:()=>true},
  });
  t.after(()=>{
    for (const id of ['sender','receiver']) service.executorExit(id);
    rmSync(root,{recursive:true,force:true}); rmSync(privateDir,{recursive:true,force:true});
  });
  service.socketFor('sender',actor);
  const receiver=service.socketFor('receiver','callee')!;
  limited=false;
  service.callOpened('c',actor,'callee',{read:[extra,'/tmp/old-tmp']},'sender');
  service.callAssigned('c','receiver');
  const open=path=>service.executorRequest('receiver','callee','files.open',{callId:'c',path,mode:'read'});
  await assert.rejects(open(extra),/denied/);
  const {handle}=await open('/tmp/old-tmp');
  assert.equal((await stream(receiver,handle,'GET')).body.toString(),'private bytes');
});

test('successful reply, cancellation, timeout and executor loss revoke the assigned handles',linux,async t => {
  const db = new DatabaseSync(':memory:');
  const store = new Store(db);
  const admin = store.ensureAdmin('file-grants@example.test');
  const app = store.create('~','app',{name:'worker',permissions:[],manifest:{
    run:{type:'process',settings:{cwd:'/',command:'node',features:{read:{
      type:'method',version:'1',description:'read'}}}},executors:{mode:'oneShot'}}});
  const jobs = [];
  const runner=Object.assign(new EventEmitter(),{dispatch:job=>jobs.push(job), rejectReply(){}, stop(){}});
  const files=new FileDelegations(store);
  const controller=new Controller(store,runner,files);
  const dir=mkdtempSync(join(tmpdir(),'pappai-finish-'));
  const path=join(dir,'test');
  writeFileSync(path,'data');
  t.after(()=>{controller.shutdown(); rmSync(dir,{recursive:true,force:true}); db.close();});
  await controller.call(admin.id,{node:app.id,method:'$.app.start'});
  for (const outcome of ['result','cancel','timeout','exit']) {
    const signal=new AbortController();
    const pending=controller.call(admin.id,{node:app.id,method:'read',read:[path],
      timeoutMs:outcome==='timeout'?60:1000},signal.signal);
    const job=jobs.at(-1);
    const endpoint=files.socketFor(job.id)!;
    const params={callId:job.id,path,mode:'read'};
    const {handle}=await files.executorRequest(job.id,app.id,'files.open',params);
    if (outcome==='result') {
      runner.emit('reply',{id:job.id,appId:app.id,result:'done'});
      assert.equal(await pending,'done');
    } else {
      if (outcome==='cancel') signal.abort();
      if (outcome==='exit') runner.emit('exit',{id:job.id,appId:app.id});
      await assert.rejects(pending,/cancel|timed out|exit/i);
    }
    await assert.rejects(files.executorRequest(job.id,app.id,'files.open',params),/denied/);
    if (outcome!=='exit') {
      assert.equal((await stream(endpoint,handle,'GET')).status,403);
      runner.emit('exit',{id:job.id,appId:app.id});
    }
  }
});

test('revoking the caller generation prevents new delegated opens while an already opened file remains usable',linux,async t=>{
  const {dir,service,socket}=fixture(t);
  const path=join(dir,'retiring');
  writeFileSync(path,'before');
  service.socketFor('sending-worker','caller');
  t.after(()=>service.executorExit('sending-worker'));
  service.callOpened('c','caller','target',{read:[path]},'sending-worker');
  service.callAssigned('c','worker');
  const open=()=>service.executorRequest('worker','target','files.open',{callId:'c',path,mode:'read'});
  const {handle}=await open();
  service.revokeView('sending-worker');
  await assert.rejects(open(),/denied/);
  assert.equal((await stream(socket,handle,'GET')).body.toString(),'before');
});
