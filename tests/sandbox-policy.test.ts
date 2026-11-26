import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { sandboxFor } from '../src/permits.ts';
import { ProcessRunner } from '../src/runner.ts';
import { Store } from '../src/store.ts';

const bwrap={skip:process.env.PAPPAI_TEST_BWRAP !== '1',timeout:10000};

test('saving filesystem permits validates existing components and preserves prior permissions', {
  skip:process.platform !== 'linux',
},t=>{
  const db=new DatabaseSync(':memory:');
  const dir=mkdtempSync('/var/tmp/pappai-permit-');
  t.after(()=>{db.close(); rmSync(dir,{recursive:true,force:true});});
  const store=new Store(db);
  const admin=store.ensureAdmin('policy@example.test');
  const original=[{read:dir}];
  const team=store.create('~','team',{name:'files',permissions:original});
  symlinkSync(dir,join(dir,'alias'));
  symlinkSync(join(dir,'absent'),join(dir,'dangling'));
  for (const path of [join(dir,'alias'),join(dir,'alias','absent'),join(dir,'dangling','file')]) {
    assert.throws(()=>store.manage(admin.id,team.id,'$.permissions.set',{permissions:[{write:path}]}),/symbolic/i);
    assert.deepEqual(store.get(team.id)?.permissions,original);
  }
  const valid=[{read:join(dir,'new','future')}];
  store.manage(admin.id,team.id,'$.permissions.set',{permissions:valid});
  assert.deepEqual(store.get(team.id)?.permissions,valid);
});

async function probe(t, rules, data, code:string) {
  const runner=new ProcessRunner();
  t.after(()=>runner.close());
  const reply=once(runner,'reply');
  const exit=once(runner,'exit');
  const script=`
    const fs=require('node:fs');
    function read(path) {try{return fs.readFileSync(path,'utf8');}catch{return null;}}
    function write(path) {try{fs.writeFileSync(path,'changed');return true;}catch{return false;}}
    process.stdin.once('data',part=>{
      const {id,data}=JSON.parse(part);
      const result=(()=>{${code}})();
      process.stdout.write(JSON.stringify({id,result})+'\\n');
      process.stdin.destroy();
    });`;
  runner.dispatch({id:'mask-probe',appId:'sandbox-policy',from:'test',method:'probe',data,
    settings:{cwd:'/',command:'node',args:['-e',script]},sandbox:sandboxFor([rules])});
  const [message]=await Promise.race([reply,exit.then(([end])=>{throw Error(end.issue ?? 'No reply');})]);
  await exit;
  return message.result;
}

test('bubblewrap masks a denied subtree and regrants a writable grandchild',bwrap,async t=>{
  const dir=mkdtempSync('/var/pappai-nested-');
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const hidden=join(dir,'hidden');
  const own=join(hidden,'own');
  mkdirSync(own,{recursive:true});
  writeFileSync(join(dir,'visible'),'parent');
  writeFileSync(join(hidden,'private'),'unavailable');
  writeFileSync(join(own,'result'),'before');
  const result=await probe(t,[{write:own},{read:hidden,deny:true},{read:dir}],{dir,hidden,own},`
    return {
      visible:read(data.dir+'/visible'), other:read(data.hidden+'/private'),
      own:read(data.own+'/result'), ownWrite:write(data.own+'/result'),
      parentWrite:write(data.dir+'/visible'), hiddenWrite:write(data.hidden+'/created'),
      listing:fs.readdirSync(data.hidden)
    };`);
  assert.deepEqual(result,{visible:'parent',other:null,own:'before',ownWrite:true,
    parentWrite:false,hiddenWrite:false,listing:['own']});
  assert.equal(readFileSync(join(own,'result'),'utf8'),'changed');
});

test('bubblewrap root grant preserves a readonly top-level exception and ordinary writes elsewhere',bwrap,async t=>{
  const readonly=mkdtempSync('/pappai-readonly-');
  const writable=mkdtempSync('/pappai-writable-');
  t.after(()=>{for (const dir of [readonly,writable]) rmSync(dir,{recursive:true,force:true});});
  writeFileSync(join(readonly,'document'),'readable');
  const result=await probe(t,[{write:readonly,deny:true},{write:true}],{readonly,writable},`
    return {
      text:read(data.readonly+'/document'),overwrite:write(data.readonly+'/document'),
      deniedCreate:write(data.readonly+'/other'),created:write(data.writable+'/result')
    };`);
  assert.deepEqual(result,{text:'readable',overwrite:false,deniedCreate:false,created:true});
  assert.equal(readFileSync(join(writable,'result'),'utf8'),'changed');
});
