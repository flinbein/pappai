import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Store } from '../src/store.ts';

test('workspace and durable nodes, defaults, email uniqueness, admin recovery', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pappai-store-'));
  const file = join(dir, 'workspace.sqlite');
  let db = new DatabaseSync(file);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  let store = new Store(db);
  assert.equal(store.get('~')?.type, 'workspace');
  assert.equal(store.visible('missing').length, 0);
  const team = store.create('~', 'team', { name: 'Finance' });
  const user = store.create(team.id, 'user', { name: 'Ana', email: 'ana@example.org' });
  const app = store.create(team.id, 'app', { name: 'echo', manifest: { features: {} } });
  assert.deepEqual(user.permissions, []);
  assert.equal(user.status, 'stopped');
  assert.equal(app.status, 'stopped');
  assert.throws(() => store.create(app.id, 'app', { name: 'nested', manifest: {} }));
  assert.throws(() => store.create('~', 'user', { name: 'duplicate', email: 'ANA@EXAMPLE.ORG' }));
  assert.equal(store.isAdmin(user.id), false);
  store.setStatus(app.id, 'error', 'runner exited');
  db.close();
  db = new DatabaseSync(file);
  store = new Store(db);
  assert.equal(store.get(app.id)?.lastIssue, 'runner exited');
  assert.deepEqual(store.get(app.id)?.manifest, { features: {} });
  assert.equal(store.byEmail(' Ana@example.org ')?.id, user.id);
  const admin = store.ensureAdmin('ana@example.org');
  assert.equal(admin.parentId, '~');
  assert.equal(admin.id, user.id);
  assert.equal(admin.status, 'working');
  assert.equal(store.isAdmin(admin.id), true);
  assert.equal(store.ensureAdmin('ana@example.org').id, admin.id);
});

test('ordered first matching method rule at each level uses selectors relative to its owner', (t) => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const store = new Store(db);
  const team = store.create('~', 'team', { name: 'project', permissions: [
    { node: './**', methods: 'chat.private.**', deny: true },
    { node: './**', nodeType: 'app', methods: 'chat.**' },
    { node: '@', methods: 'self' }
  ] });
  const app = store.create(team.id, 'app', { name: 'target', manifest: {} });
  const outside = store.create('~', 'app', { name: 'other', manifest: {} });
  const user = store.create(team.id, 'user', { name: 'user', email: 'u@example.org', permissions: [
    { node: ['!' + outside.id, true], methods: ['chat.*', 'chat.private.**', 'self'] }
  ] });
  store.setStatus(user.id, 'working');
  assert.equal(store.allows(user.id, app.id, 'chat.send'), true);
  assert.equal(store.allows(user.id, app.id, 'chat.private.view'), false);
  assert.equal(store.allows(user.id, app.id, 'chat.message.send'), false);
  assert.equal(store.allows(user.id, app.id, 'chat'), false);
  assert.equal(store.allows(user.id, outside.id, 'chat.send'), false);
  assert.equal(store.allows(user.id, user.id, 'self'), true);
  assert.equal(store.isAdmin(user.id), false);
});

test('directory adds only ancestors and never exposes settings or email', (t) => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const store = new Store(db);
  const team = store.create('~', 'team', { name: 'team', permissions: null });
  const app = store.create(team.id, 'app', { name:'app', manifest: { run: {secret:'private'} } });
  const user = store.create('~', 'user', { name:'visitor', email:'u@example.org',
    permissions:[{ node:app.id, discover:true }] });
  store.setStatus(user.id, 'working');
  assert.equal(store.canDiscover(user.id, team.id), false);
  assert.deepEqual(new Set(store.visible(user.id).map(n => n.id)), new Set(['~', team.id, app.id]));
  const leaf = store.visible(user.id).find(n => n.id === app.id);
  assert.deepEqual(leaf, {id:app.id, parentId:team.id, name:'app', type:'app', status:'stopped'});
});

test('sandbox intersects path and network grants, null on a restricted branch is still restricted', (t) => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const store = new Store(db);
  const team = store.create('~', 'team', { name: 'outer', permissions: [
    {read:'/data/in', write:'/data/out', network:true, deny:false}
  ] });
  const app = store.create(team.id,'app',{name:'inner', manifest:{}, permissions:[
    {network:true, deny:true}, {network:true, write:['/data', '/extra']}
  ]});
  const effective = store.sandbox(app.id);
  assert.ok(effective);
  assert.equal(effective.network,false);
  assert.deepEqual(effective.read,['/data/in']);
  assert.deepEqual(effective.write,['/data/out']);
  const inherited = store.create(team.id,'app',{name:'inherited', permissions:null, manifest:{}});
  assert.equal(store.isAdmin(inherited.id),false);
  assert.equal(store.sandbox(inherited.id)?.network,true);
  const full = store.create('~','app',{name:'full', permissions:null, manifest:{}});
  assert.equal(store.sandbox(full.id),null);
  const limited = store.create('~','app',{name:'limited', manifest:{}});
  assert.deepEqual(store.sandbox(limited.id),{read:[],write:[],network:false});
});

test('malformed rules and invalid filesystem paths are rejected before use', (t) => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const store = new Store(db);
  for (const rule of [
    { node:'!x', methods:true }, { node:'*', methods:true }, {node:'@/**', methods:true},
    { node:['~','!x'], discover:true }, { methods: { a: { type:'unknown' } } },
    { methods:true, customCondition:true }, { write:'/opt/../private' }, { read:'relative' }
  ]) {
    assert.throws(() => store.create('~','app',{name:'bad',manifest:{},permissions:[rule]}));
  }
  const app = store.create('~','app',{name:'example',manifest:{},permissions:[{read:'/data/secret',deny:true},{write:'/data'}]});
  assert.equal(store.allowsFile(app.id,'/data/public',true),true);
  assert.equal(store.allowsFile(app.id,'/data/secret/x'),false);
});

test('membership composes grants through the TEAM and preserves restrictions on the member', t=>{
  const db=new DatabaseSync(':memory:'); t.after(()=>db.close());
  const store=new Store(db), admin=store.ensureAdmin('owner@example.test');
  const home=store.create('~','team',{name:'home',permissions:[]});
  const other=store.create('~','team',{name:'other',permissions:[{methods:'data.save',read:'/shared'}]});
  const target=store.create('~','app',{name:'storage',manifest:{}});
  const user=store.create(home.id,'user',{name:'member',email:'member@example.test',
    permissions:[{methods:{'data.save':{type:'integer'}},read:'/shared'}]});
  store.setStatus(user.id,'working');
  const check=(data:unknown)=>store.allows(user.id,target.id,'data.save',data);
  assert.equal(check(1),false);
  store.manage(admin.id,other.id,'$.team.members.add',{appId:user.id});
  assert.equal(check(1),true);
  assert.equal(check('string'),false);
  assert.equal(store.selects(other.id,user.id,'./&'),true);
  assert.equal(store.allowsFile(user.id,'/shared/input'),true);
  assert.equal(store.allowsFile(user.id,'/shared/input',true),false);
  assert.equal(store.isAdmin(user.id),false);
  store.manage(admin.id,user.id,'$.app.memberships.delete',{teamId:other.id});
  assert.equal(check(1),false);
  assert.equal(store.allowsFile(user.id,'/shared/input'),false);
});
