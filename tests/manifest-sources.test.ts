import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout } from 'node:timers/promises';
import { ManifestSources } from '../src/manifest-sources.ts';
import { Store } from '../src/store.ts';
import { prepare } from '../src/manifest.ts';

async function until(check) {
  for (let i = 0; i < 100; ++i) {
    if (check()) return;
    await setTimeout(35);
  }
  assert.ok(check(),'Expected watcher to publish new state');
}
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(),'pappai-manifest-'));
  const file = join(dir,'manifest.json');
  const manifest = {run:{type:'process',settings:{command:'node',features:{},env:{BASE:'package'}}},
    executors:{mode:'persistent'}};
  const publish = manifest => {
    writeFileSync(file + '.new',JSON.stringify(manifest));
    renameSync(file + '.new',file);
  };
  publish(manifest);
  const db = new DatabaseSync(':memory:');
  const store = new Store(db);
  const admin = store.ensureAdmin('admin@example.test');
  const running = new Set(), denied = new Set();
  const hooks = {hasRunner:t=>t === 'process',isPersistentRunning:id=>running.has(id),
    apply:(id,manifest)=>store.setManifest(id,manifest),changed:()=>{},failed:(id,issue)=>store.setStatus(id,'error',issue)};
  // Native Windows fixtures use a drive-letter path; production permits use Linux paths.
  const permission = store.allowsFile.bind(store);
  store.allowsFile = (id,path,write) => !denied.has(id) && (process.platform==='win32' ? path===file : permission(id,path,write));
  const manager = new ManifestSources(store,hooks);
  const call = (id,method,data={}) => manager.system(admin.id,store.get(id),method,data).result;
  const create = override => call('~','$.app.create',{name:'Hook',permissions:null,source:{file,override}}).id;
  t.after(()=>{manager.close(); db.close(); rmSync(dir,{force:true,recursive:true});});
  return {dir,file,manifest,publish,store,manager,call,create,running,denied};
}

test('per-APP secrets are masked, replaced, removed, and a mask cannot recreate a removed secret', t=>{
  const {file,store,create,call} = setup(t);
  const patch = env=>({run:{settings:{env}}});
  const id = create(patch({TOKEN:{secret:'one'},BASE:null}));
  const source = call(id,'$.app.manifest.get');
  assert.deepEqual(source,{file,override:patch({TOKEN:{secret:true},BASE:null})});
  assert.deepEqual(call(id,'$.app.manifest.getApplied').run.settings.env,{TOKEN:{secret:true}});
  assert.deepEqual(prepare(store.get(id).manifest).settings.env,{TOKEN:'one'});
  call(id,'$.app.manifest.set',{source});
  assert.equal(prepare(store.get(id).manifest).settings.env.TOKEN,'one');
  assert.throws(()=>call(id,'$.app.manifest.set',{source:{file,override:{run:{settings:{command:'foo'}}}}}),/override/);
  call(id,'$.app.manifest.set',{source:{file,override:patch({})}});
  assert.deepEqual(prepare(store.get(id).manifest).settings.env,{BASE:'package'});
  assert.throws(()=>call(id,'$.app.manifest.set',{source}),/mask/);
  assert.equal(store.get(id).manifest.run.settings.cwd,dirname(file));
});

test('APP method schemas use static JSON Schema; node selectors belong to permits', ()=>{
  const features = {run:{type:'method',version:'1',description:'Run',schema:{input:{node:'.'}}}};
  assert.throws(()=>prepare({run:{type:'process',settings:{command:'node',cwd:tmpdir(),features}},
    executors:{mode:'oneShot'}}),/schema|selector/i);
});

test('atomic replacement updates each permitted APP, defers a running persistent APP and fails a denied reader', async t=>{
  const {manifest,publish,store,create,manager,call,running,denied} = setup(t);
  const a = create({}), b = create({subscriptions:[]}), c = create({});
  running.add(a);
  denied.add(c);
  const v2 = {...manifest,subscriptions:[{events:'work.event'}]};
  publish(v2);
  await until(()=>manager.manifestChanged(a) && store.get(c).status === 'error');
  assert.equal(store.get(a).manifest.subscriptions,undefined);
  assert.deepEqual(store.get(b).manifest.subscriptions,[]);
  running.delete(a);
  manager.applyPending(a);
  assert.deepEqual(store.get(a).manifest.subscriptions,v2.subscriptions);
  assert.equal(manager.manifestChanged(a),false);
  assert.throws(()=>call(c,'$.app.start'),/denied/i);
  assert.deepEqual(store.get(c).manifest.subscriptions,undefined);
});

test('invalid source creation is atomic and existing inline nodes can switch to a watched file', t=>{
  const {call,file,store} = setup(t);
  const manifest = {run:{type:'process',settings:{command:'node',cwd:dirname(file),features:{}}},executors:{mode:'oneShot'}};
  const id = store.create('~','app',{name:'legacy',permissions:null,manifest}).id;
  assert.deepEqual(call(id,'$.app.manifest.get'),{manifest});
  const count = store.db.prepare('SELECT count(*) AS n FROM nodes').get().n;
  assert.throws(()=>call('~','$.app.create',{name:'bad',httpName:'webhook',permissions:null,source:{file:file + '.missing'}}));
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM nodes').get().n,count);
  assert.equal(store.getByHttpName('webhook'),undefined);
  call(id,'$.app.manifest.set',{source:{file}});
  assert.deepEqual(call(id,'$.app.manifest.get'),{file});
});

test('delegated package installation rejects a later symlink to another authorized file',
  {skip:process.platform!=='linux'},async t=>{
    const {manager,store,manifest} = setup(t);
    const dir = mkdtempSync('/var/tmp/pappai-publisher-');
    t.after(()=>rmSync(dir,{force:true,recursive:true}));
    const file=join(dir,'manifest.json'), moved=join(dir,'other.json');
    const user = store.create('~','user',{name:'operator',email:'op@example.test',
      permissions:[{node:'~',methods:'$.app.create'}]});
    store.setStatus(user.id,'working');
    writeFileSync(file,JSON.stringify(manifest));
    const {id} = manager.system(user.id,store.get('~'),'$.app.create',{
      name:'published',source:{file},permissions:[{read:dir}]}).result;
    renameSync(file,moved);
    symlinkSync(moved,file);
    await until(()=>store.get(id).status==='error');
    assert.match(store.get(id).lastIssue,/denied/i);
  });
