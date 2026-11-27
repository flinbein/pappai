import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { request, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
import { createService } from '../src/server.ts';

async function startWeb(t: TestContext, webRoot = '') {
  const origin = 'http://localhost:32393';
  const db = new DatabaseSync(':memory:');
  const s = createService({ db, origin, webRoot });
  t.after(async () => {
    await s.close();
    db.close();
  });
  s.server.listen(0, '127.0.0.1');
  await once(s.server, 'listening');
  const port = (s.server.address() as AddressInfo).port;
  const send = (path: string, method = 'GET', extra = {}, payload?: object) =>
    new Promise<{ status: number; body: string; headers: IncomingHttpHeaders }>((resolve, reject) => {
      const req = request({
        hostname: '127.0.0.1', port, path, method,
        headers: { Host: 'localhost:32393', Origin: origin, 'Content-Type': 'application/json', ...extra },
      }, res => {
        let body = '';
        res.setEncoding('utf8').on('data', chunk => body += chunk);
        res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }));
      });
      req.on('error', reject);
      req.end(payload === undefined ? undefined : JSON.stringify(payload));
    });
  return {send,db,store:s.store,port,origin};
}

function signIn(db: DatabaseSync, actor: string) {
  const hash = createHash('sha256').update('test-session').digest('hex');
  db.prepare('INSERT INTO passkeys VALUES(?,?,?,?)').run('key', actor, Buffer.alloc(4), 0);
  db.prepare('INSERT INTO web_sessions VALUES(?,?,?,?)').run(hash, 'key', Date.now()+60000, Date.now()+60000);
  return {Cookie: 'pappai-local-session=test-session'};
}

test('HTTP and WebSocket RPC apply the same restrictions to discovery, help, calls and permission checks',async t=>{
  const {send,store,db,port,origin}=await startWeb(t);
  const actor=store.ensureAdmin('rpc@example.test').id;
  const headers=signIn(db,actor);
  const subject=store.create('~','team',{name:'limited',permissions:[{node:'.',discover:true,methods:'$.node.get'}]}).id;
  const ws=new WebSocket('ws://127.0.0.1:'+port+'/api/ws/web',{origin,headers:{...headers,Host:new URL(origin).host}});
  await once(ws,'open');
  t.after(()=>ws.terminate());
  const http=async (method:string,params:object)=>JSON.parse((await send('/api/rpc','POST',headers,{jsonrpc:'2.0',id:1,method,params})).body);
  const socket=async (method:string,params:object)=>{
    const response=once(ws,'message');
    ws.send(JSON.stringify({jsonrpc:'2.0',id:1,method,params}));
    return JSON.parse(String((await response)[0]));
  };
  const limits={restrictPermissions:[subject]};
  for (const rpc of [http,socket]) {
    assert.deepEqual((await rpc('discover',limits)).result.map(n=>n.id),['~',subject]);
    assert.deepEqual((await rpc('help',{node:'~',...limits})).result,{});
    assert.ok((await rpc('help',{node:subject,features:'$.permissions.set',...limits})).result['$.permissions.set']);
    const call={node:subject,method:'$.node.get',data:{}};
    assert.deepEqual((await rpc('checkPermissions',{subject,action:{type:'call',...call}})).result,{allowed:true});
    assert.equal((await rpc('call',{...call,...limits})).result.id,subject);
    assert.deepEqual((await rpc('checkPermissions',{action:{type:'call',...call},permissions:[]})).result,{allowed:false});
    assert.deepEqual((await rpc('checkPermissions',{action:{type:'read',path:'/tmp/host-input'},...limits})).result,{allowed:false});
    assert.equal((await rpc('call',{...call,...limits,permissions:[]})).error.message,'Permission denied');
    assert.equal((await rpc('discover',{restrictPermissions:['missing']})).error.message,'Permission denied');
  }
});

test('bundled panel and assets are public; terminal and RPC retain their access checks', async t => {
  const {send} = await startWeb(t);
  const panel = await send('/');
  assert.equal(panel.status, 200);
  assert.match(panel.headers['content-type']!, /^text\/html/);
  assert.equal(panel.headers['cache-control'], 'no-store');
  assert.match(panel.headers['content-security-policy']!, /frame-ancestors 'none'/);
  const script = panel.body.match(/src="(\/_web\/[^/"]+\/assets\/[^"]+\.js)"/)?.[1];
  assert.ok(script, 'panel references a versioned JS asset');
  const asset = await send(script);
  assert.equal(asset.status, 200);
  assert.match(asset.headers['content-type']!, /javascript/);
  assert.match(asset.headers['cache-control']!, /immutable/);
  assert.equal(asset.headers['x-content-type-options'], 'nosniff');
  for (const path of ['/terminal', '/terminal?sandbox=1']) {
    const terminal = await send(path);
    assert.equal(terminal.status, 303);
    assert.equal(terminal.headers.location, '/');
  }
  for (const path of ['/nodes/~', '/nodes/abc/methods/%24.lifecycle.start', '/nodes/abc/create/team',
    '/nodes/abc/chat', '/runners', '/rpc']) {
    const page = await send(path);
    assert.equal(page.status, 200, path);
    assert.equal(page.body, panel.body);
    assert.match(page.headers['content-security-policy']!, /style-src 'self' 'unsafe-inline'/);
  }
  for (const path of ['/nodes', '/nodes/', '/nodes//methods/name', '/runners/unknown', '/api/rpc', '/unknown']) {
    assert.equal((await send(path)).status, 404, path);
  }
  assert.equal((await send('/nodes/abc', 'POST')).status, 404);
  for (const path of ['/rpc','/api/rpc']) {
    assert.equal((await send(path, 'POST')).status, 401);
    assert.equal((await send(path, 'POST', { Origin: 'https://other.example' })).status, 403);
  }
  assert.equal((await send('/files/')).status, 401);
  for (const path of ['/api','/api/','/api/files/','/api/terminal','/api/ws/web','/api/ws/terminal',
    '/api/api/session','/api/auth/unknown','/api'+script]) {
    assert.equal((await send(path)).status,404,path);
    assert.equal((await send(path,'POST')).status,404,path);
  }
  assert.equal((await send('/', 'GET', { Host: 'other.example' })).status, 404);
  assert.equal((await send('/api/session','GET',{Host:'other.example'})).status,404);
});

test('stopping a USER revokes all its sessions, closes terminal and event connections and retains passkeys',async t=>{
  const {send,db,store,port,origin}=await startWeb(t);
  const actor=store.ensureAdmin('operator@example.test').id;
  const headers=signIn(db,actor);
  const otherCookie='another-browser';
  const hash=createHash('sha256').update(otherCookie).digest('hex');
  db.prepare('INSERT INTO web_sessions VALUES(?,?,?,?)').run(hash,'key',Date.now()+60000,Date.now()+60000);
  const clients=await Promise.all([
    {path:'/api/ws/web',cookie:headers.Cookie},
    {path:'/api/ws/terminal?start=manual',cookie:'pappai-local-session='+otherCookie},
  ].map(async ({path,cookie})=>{
    const ws=new WebSocket('ws://127.0.0.1:'+port+path,{origin,headers:{Cookie:cookie,Host:new URL(origin).host}});
    await once(ws,'open');
    return ws;
  }));
  const closed=Promise.all(clients.map(ws=>once(ws,'close')));
  const reply=await send('/api/rpc','POST',headers,{jsonrpc:'2.0',id:1,method:'call',
    params:{node:actor,method:'$.lifecycle.stop',data:{}}});
  assert.deepEqual(JSON.parse(reply.body).result,{});
  await closed;
  assert.equal(store.get(actor)?.status,'stopped');
  assert.equal(db.prepare('SELECT count(*) AS n FROM web_sessions').get()!.n,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM passkeys').get()!.n,1);
});

test('HTTP and both WebSockets share the same USER session and canonical logout revokes it',async t=>{
  const {send,db,store,port,origin}=await startWeb(t);
  const actor=store.ensureAdmin('api@example.test').id;
  const headers=signIn(db, actor);
  const {browserSession}=JSON.parse((await send('/api/session','GET',headers)).body);
  assert.ok(typeof browserSession === 'string' && browserSession.length > 0);
  assert.notEqual(browserSession,'test-session');
  assert.notEqual(browserSession,createHash('sha256').update('test-session').digest('hex'));
  const secondCookie='another-session';
  const secondHeaders={Cookie:'pappai-local-session='+secondCookie};
  db.prepare('INSERT INTO web_sessions VALUES(?,?,?,?)').run(createHash('sha256').update(secondCookie).digest('hex'),'key',Date.now()+60000,Date.now()+60000);
  const secondIdentity=JSON.parse((await send('/api/session','GET',secondHeaders)).body);
  assert.equal(secondIdentity.user,actor);
  assert.notEqual(secondIdentity.browserSession,browserSession);
  assert.equal((await send('/api/rpc','POST',{Cookie:'pappai-local-session='+browserSession},{})).status,401);
  for (const prefix of ['', '/api']) {
    const session=await send(prefix+'/session','GET',headers);
    assert.deepEqual(JSON.parse(session.body),{user:actor,browserSession,canChooseSandbox:true,canManageApps:true});
    const rpc=await send(prefix+'/rpc','POST',headers,{jsonrpc:'2.0',id:1,method:'discover'});
    assert.ok(JSON.parse(rpc.body).result.some(node=>node.id===actor));
    const login=await send(prefix+'/auth/login/options','POST',{},{});
    assert.equal(login.status,200);
    assert.ok(JSON.parse(login.body).challenge);
  }
  for (const path of ['/api/ws/web?browserSession=', '/api/ws/terminal?start=manual&browserSession=']) {
    const ws=new WebSocket('ws://127.0.0.1:'+port+path+browserSession,{origin,headers:{...secondHeaders,Host:new URL(origin).host}});
    const [,response]=await once(ws,'unexpected-response');
    assert.equal(response.statusCode,401);
    response.resume();
    ws.on('error',()=>{});
    ws.terminate();
  }
  const clients=await Promise.all(['/api/ws/web','/ws/events','/api/ws/web?browserSession='+browserSession,
    '/api/ws/terminal?browserSession='+browserSession+'&start=manual'].map(async path=>{
    const ws=new WebSocket('ws://127.0.0.1:'+port+path,{origin,headers:{...headers,Host:new URL(origin).host}});
    await once(ws,'open');
    return ws;
  }));
  const closed=Promise.all(clients.map(ws=>once(ws,'close')));
  assert.equal((await send('/api/auth/logout','POST',headers,{})).status,200);
  await closed;
  assert.deepEqual(JSON.parse((await send('/api/session','GET',headers)).body),{user:null,canChooseSandbox:false,canManageApps:false});
  assert.deepEqual(JSON.parse((await send('/api/session','GET',secondHeaders)).body),secondIdentity);
  assert.equal((await send('/api/rpc','POST',headers,{})).status,401);
});

test('switching current changes the entry while retained assets keep their original bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pappai-web-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const {send, db, store} = await startWeb(t, root);
  const headers = signIn(db, store.ensureAdmin('panel@example.test').id);
  const bundled = await send('/');
  assert.equal(bundled.status, 200);

  async function activate(version: string, terminalEntry: string) {
    const dir = join(root, 'releases', version);
    await mkdir(join(dir, 'assets'), { recursive: true });
    await writeFile(join(dir, 'index.html'), `<script src="/_web/${version}/assets/panel.js"></script>`);
    await writeFile(join(dir, 'terminal.html'), terminalEntry);
    await writeFile(join(dir, 'assets', 'panel.js'), JSON.stringify(version));
    await writeFile(join(root, 'next'), version + '\n');
    await rename(join(root, 'next'), join(root, 'current'));
  }
  await activate('3.0.0', 'legacy standalone terminal');
  const worker=await send('/api/web-worker-v1.js');
  assert.equal(worker.headers['cache-control'],'no-store');
  assert.match(worker.headers['content-type']!,/javascript/);
  assert.match(worker.body, /\/_web\/3\.0\.0\/assets\/shared-worker\.js/);
  assert.match((await send('/')).body, /\/_web\/3\.0\.0\//);
  assert.equal((await send('/terminal', 'GET', headers)).body, 'legacy standalone terminal');
  await activate('3.1.0', '<script src="/_web/3.1.0/assets/panel.js"></script>');
  assert.match((await send('/api/web-worker-v1.js')).body,/\/_web\/3\.1\.0\/assets\/shared-worker\.js/);
  assert.match((await send('/')).body, /\/_web\/3\.1\.0\//);
  const terminal = await send('/terminal?sandbox=1', 'GET', headers);
  assert.equal(terminal.status, 200);
  assert.equal(terminal.body, (await send('/nodes/~/create/app')).body);
  assert.match(terminal.headers['content-security-policy']!, /style-src 'self' 'unsafe-inline'/);
  for (const version of ['3.0.0', '3.1.0']) {
    const asset = await send(`/_web/${version}/assets/panel.js`);
    assert.equal(asset.status, 200);
    assert.equal(JSON.parse(asset.body), version);
  }
  for (const path of ['/_web/3.1.0/index.html', '/_web/3.1.0/terminal.html', '/_web/3.1.0/assets/../index.html',
    '/_web/3.1.0/assets/%2e%2e%2findex.html', '/_web/3.1.0/assets/missing.js', '/_web/9.9.9/assets/panel.js']) {
    const response = await send(path);
    assert.equal(response.status, 404, path);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  await rm(join(root, 'current'));
  assert.equal((await send('/')).body, bundled.body);
  assert.equal((await send('/_web/3.0.0/assets/panel.js')).status, 200);
});
