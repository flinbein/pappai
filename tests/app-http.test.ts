import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { AppHttpSockets, createAppHttpRouter } from '../src/app-http.ts';

test('HTTP isolates panel cookies, switches new requests to a distinct socket and preserves an open response', async t=>{
  const dir = mkdtempSync(join(tmpdir(),'pappai-proxy-test-'));
  const pathFor = name=>process.platform==='win32' ? '\\\\.\\pipe\\pappai-' + randomUUID() : join(dir,name);
  const first = pathFor('first'), second = pathFor('second');
  const ready = [];
  let complete;
  const service = path=>{
    const server = createServer((req,res)=>{
      if (req.url === '/stream') {
        res.write('first');
        complete = ()=>res.end('-complete');
        return;
      }
      res.setHeader('Set-Cookie',['app=host; Path=/','app=domain; Domain=example.test','__Host-pappai-session=forged']);
      res.end(JSON.stringify([path===first ? 'one':'two',req.url,req.headers.cookie]));
    });
    ready.push(once(server,'listening'));
    server.listen(path);
    return server;
  };
  const one = service(first), two = service(second);
  let destination = first;
  const edge = createServer(createAppHttpRouter('{name}.example.test','panel.example.test',
    name=>name==='demo' ? destination : undefined));
  ready.push(once(edge,'listening'));
  edge.listen(0,'127.0.0.1');
  t.after(async ()=>{
    await Promise.all([one,two,edge].map(s=>new Promise(r=>{s.close(r);s.closeAllConnections();})));
    rmSync(dir,{recursive:true,force:true});
  });
  await Promise.all(ready);
  const get = (path,host='demo.example.test')=>new Promise((resolve,reject)=>{
    const r = request({host:'127.0.0.1',port:edge.address().port,path,headers:{Host:host,
      Cookie:'__Host-pappai-session=private; app=public; pappai-local-flow=private'}},resolve);
    r.on('error',reject).end();
  });
  const body = async response=>{
    const chunks = [];
    for await (const chunk of response) chunks.push(chunk);
    return Buffer.concat(chunks).toString();
  };
  const r = await get('/info?q=1');
  assert.equal(r.statusCode,200);
  assert.deepEqual(r.headers['set-cookie'],['app=host; Path=/']);
  assert.deepEqual(JSON.parse(await body(r)),['one','/info?q=1','app=public']);
  const stream = await get('/stream');
  destination = second;
  assert.deepEqual(JSON.parse(await body(await get('/next'))),['two','/next','app=public']);
  complete();
  assert.equal(await body(stream),'first-complete');
  destination = null;
  assert.equal((await get('/healthz')).statusCode,503);
  for (const host of ['panel.example.test','demo.example.test.attacker.test','unknown.example.test'])
    assert.equal((await get('/session',host)).statusCode,404);
  if (process.platform==='linux') {
    destination = join(dir,'link');
    symlinkSync(first,destination);
    assert.equal((await get('/symlink')).statusCode,503);
  }
});

test('persistent executors receive private mounts that survive retire until exit', {skip:process.platform!=='linux'},()=>{
  const sockets = new AppHttpSockets();
  const job = {id:'one',appId:'web',settings:{env:{TOKEN:'1'}},sandbox:{}};
  try {
    sockets.start(job);
    const first = sockets.socket('web');
    assert.equal(job.settings.env.PAPPAI_HTTP_SOCKET,'/run/pappai/http/app.sock');
    assert.deepEqual(job.runtimeMounts,[{source:first.slice(0,-'/app.sock'.length),target:'/run/pappai/http',readonly:false}]);
    sockets.retire('one');
    assert.equal(sockets.socket('web'),null);
    const next = {id:'two',appId:'web',sandbox:null,settings:{}};
    sockets.start(next);
    assert.notEqual(next.settings.env.PAPPAI_HTTP_SOCKET,first);
    sockets.exit('one');
    assert.equal(sockets.socket('web'),next.settings.env.PAPPAI_HTTP_SOCKET);
  } finally { sockets.close(); }
});
