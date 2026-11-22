import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { serveUserFiles } from '../src/file-browser.ts';
import { sandboxPrivateTmp } from '../src/sandbox.ts';
import { createService } from '../src/server.ts';

const linux={skip:process.platform !== 'linux'};
async function fixture(t) {
  const dir=mkdtempSync('/var/tmp/pappai-fs-');
  const actor='file-browser-'+dir.split('-').at(-1);
  const backing=sandboxPrivateTmp(actor);
  const grants=new Set<string>(['/tmp']);
  const denies=new Set<string>();
  const contains=(root:string,path:string)=>path===root || path.startsWith(root+'/');
  const store={fileSnapshot:()=>{
    const read=[...grants], hide=[...denies];
    return {sandbox:{read,hide,write:[]},allows:(path:string)=>
      read.some(p=>contains(p,path)) && !hide.some(p=>contains(p,path))};
  }};
  const server=createServer((req,res)=>void serveUserFiles(store,actor,req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port+'/files';
  t.after(async ()=>{
    const end=new Promise(resolve=>server.close(resolve));
    server.closeAllConnections(); await end;
    rmSync(dir,{recursive:true,force:true}); rmSync(backing,{recursive:true,force:true});
  });
  return {dir,base,grants,denies,backing};
}

test('synthetic pages show only existing permitted branches and escape names',linux,async t=>{
  const {dir,base,grants,denies}=await fixture(t);
  mkdirSync(join(dir,'nested'));
  const name='<ok>&.html', file=join(dir,'nested',name);
  writeFileSync(file,'<script>download</script>');
  writeFileSync(join(dir,'hidden'),'hidden');
  mkdirSync(join(dir,'ghost'));
  grants.add(file);
  grants.add(join(dir,'ghost','missing'));
  const response=await fetch(base+dir);
  assert.equal(response.status,200);
  assert.match(await response.text(), /nested/);
  const list=await (await fetch(base+dir)).text();
  assert.doesNotMatch(list,/hidden|ghost/);
  const nested=await (await fetch(base+dir+'/nested')).text();
  assert.match(nested,/&lt;ok&gt;&amp;\.html/);
  assert.match(nested,/%3Cok%3E%26\.html/);
  const downloaded=await fetch(base+dir+'/nested/'+encodeURIComponent(name));
  assert.equal(downloaded.status,200);
  assert.match(downloaded.headers.get('Content-Disposition'),/^attachment/);
  assert.equal(downloaded.headers.get('X-Content-Type-Options'),'nosniff');
  assert.equal(downloaded.headers.get('Cache-Control'),'no-store');
  assert.equal(await downloaded.text(),'<script>download</script>');
  assert.equal((await fetch(base+dir+'/missing')).status,403);
  assert.equal((await fetch(base+dir+'/ghost')).status,403);
  assert.equal((await fetch(base+dir+'/ghost/missing')).status,404);
  grants.add(dir); denies.add(join(dir,'hidden'));
  assert.doesNotMatch(await (await fetch(base+dir)).text(),/hidden/);
});

test('links resolve in the USER file view and protect service and hidden targets',linux,async t=>{
  const {dir,base,grants,backing}=await fixture(t);
  const publicDir=join(dir,'public');
  mkdirSync(publicDir);
  grants.add(publicDir);
  writeFileSync(join(backing,'secret'),'my private bytes');
  symlinkSync('/tmp/secret',join(publicDir,'my alias'));
  symlinkSync('/proc/self/status',join(publicDir,'proc-status'));
  symlinkSync(join(dir,'forbidden'),join(publicDir,'hidden-link'));
  symlinkSync('./missing',join(publicDir,'broken'));
  writeFileSync(join(dir,'forbidden'),'inaccessible');
  const list=await (await fetch(base+publicDir)).text();
  for (const name of ['my alias','proc-status','hidden-link','broken']) assert.ok(list.includes(name));
  const actual=await fetch(base+publicDir+'/my%20alias');
  assert.equal(await actual.text(),'my private bytes');
  assert.equal(actual.headers.get('X-Pappai-File-Path'),'/tmp/secret');
  assert.match(actual.headers.get('Content-Disposition'),/my%20alias/);
  for (const path of ['/proc','/dev/null',publicDir+'/proc-status',publicDir+'/hidden-link']) {
    const result=await fetch(base+path);
    assert.equal(result.status,403);
    assert.equal(result.headers.get('X-Pappai-File-Path'),null);
  }
  assert.equal((await fetch(base+publicDir+'/broken')).status,404);
});

test('active download streams to completion after permit revocation; next request is denied',linux,async t=>{
  const {dir,base,grants}=await fixture(t);
  const path=join(dir,'large');
  writeFileSync(path,Buffer.alloc(8*1024*1024,74));
  grants.add(path);
  const res=await new Promise((resolve,reject)=>get(base+path,resolve).on('error',reject));
  assert.equal(res.statusCode,200);
  grants.delete(path);
  assert.equal((await fetch(base+path)).status,403);
  let bytes=0;
  for await (const chunk of res) bytes+=chunk.length;
  assert.equal(bytes,8*1024*1024);
});

test('panel checks its USER session and effective file permits at the download route',linux,async t=>{
  const db=new DatabaseSync(':memory:');
  const service=createService({db,origin:'http://localhost'});
  const dir=mkdtempSync('/var/tmp/pappai-files-route-');
  const path=join(dir,'allowed.txt');
  writeFileSync(path,'scoped file');
  const user=service.store.create('~','user',{name:'reader',email:'reader@example.test',permissions:[{read:path}]});
  service.store.setStatus(user.id,'working');
  db.prepare('INSERT INTO passkeys VALUES(?,?,?,?)').run('test-key',user.id,Buffer.alloc(1),0);
  const hash=createHash('sha256').update('test-session').digest('hex');
  db.prepare('INSERT INTO web_sessions VALUES(?,?,?,?)').run(hash,'test-key',Date.now()+60000,Date.now()+60000);
  await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
  t.after(async ()=>{await service.close(); db.close(); rmSync(dir,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+service.server.address().port+'/files';
  const download=(name,auth=false)=>new Promise((resolve,reject)=>{
    const headers=auth ? {host:'localhost',cookie:'pappai-local-session=test-session'} : {host:'localhost'};
    get(base+name,{headers},async res=>{
      try {
        let body=''; for await (const part of res) body+=part;
        resolve({status:res.statusCode,body});
      } catch (err) {reject(err);}
    }).on('error',reject);
  });
  assert.equal((await download(path)).status,401);
  assert.deepEqual(await download(path,true),{status:200,body:'scoped file'});
  assert.equal((await download(join(dir,'ungranted'),true)).status,403);
});
