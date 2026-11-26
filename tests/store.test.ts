import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { normalizeCreateTeamData, Store } from '../src/store.ts';

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
  const change=(method:string)=>store.manage(admin.id,other.id,method,{memberId:user.id}).changed;
  assert.equal(change('$.team.members.add'),true);
  assert.equal(change('$.team.members.add'),false);
  assert.deepEqual(store.permissionSubjects(other.id),[user.id]);
  assert.deepEqual(store.permissionSubjects(home.id),[user.id]);
  assert.deepEqual(new Set(store.permissionSubjects()),new Set([admin.id,target.id,user.id]));
  assert.deepEqual(store.manage(admin.id,user.id,'$.memberships.list',{}).result,[other.id]);
  assert.deepEqual(store.manage(admin.id,other.id,'$.team.members.list',{}).result,[user.id]);
  assert.equal(check(1),true);
  assert.equal(check('string'),false);
  assert.equal(store.selects(other.id,user.id,'./&'),true);
  assert.equal(store.allowsFile(user.id,'/shared/input'),true);
  assert.equal(store.allowsFile(user.id,'/shared/input',true),false);
  assert.equal(store.isAdmin(user.id),false);
  assert.equal(store.manage(admin.id,user.id,'$.app.memberships.delete',{teamId:other.id}).handled,false);
  assert.equal(change('$.team.members.remove'),true);
  assert.equal(change('$.team.members.remove'),false);
  assert.deepEqual(store.permissionSubjects(other.id),[]);
  assert.equal(check(1),false);
  assert.equal(store.allowsFile(user.id,'/shared/input'),false);
});

test('TEAM defaults delegate creation on the team and node management below it', t=>{
  const db=new DatabaseSync(':memory:'); t.after(()=>db.close());
  const store=new Store(db), settings={name:'branch'};
  const team=store.create('~','team',settings);
  assert.deepEqual(team.permissions,normalizeCreateTeamData(settings).permissions);
  const user=store.create(team.id,'user',{name:'manager',email:'manager@example.test',permissions:null});
  store.setStatus(user.id,'working');
  for (const type of ['Team','User','App','Profile']) assert.ok(store.allows(user.id,team.id,'$.children.create'+type));
  assert.equal(store.allows(user.id,team.id,'$.permissions.set'),false);
  assert.equal(store.allows(user.id,team.id,'$.team.members.add'),false);
  assert.equal(store.allows(user.id,user.id,'$.permissions.set'),true);
  assert.equal(store.allows(user.id,'~','$.children.createTeam'),false);
  assert.equal(store.allowsCli(user.id,user.id,'shell',{}),true);
  assert.equal(store.allowsEvent(user.id,user.id,'update'),true);
  assert.equal(store.canDiscover(user.id,user.id),true);
  assert.equal(store.hasHttp(user.id),false);
  assert.equal(store.allowsFile(user.id,'/private/report'),false);
  assert.equal(store.sandbox(user.id)?.network,false);
  for (const permissions of [null,[],[{read:'/data'}]]) {
    assert.deepEqual(store.create('~','team',{name:'custom',permissions}).permissions,permissions);
  }
});

test('local permission changes respect rule order and ignore object key order', t=>{
  const db=new DatabaseSync(':memory:'); t.after(()=>db.close());
  const store=new Store(db), owner=store.ensureAdmin('owner@example.test');
  const profile=store.create('~','profile',{name:'profile',scope:[true]});
  const manage=(method:string,data={})=>store.manage(owner.id,profile.id,method,data);
  const rules=[{node:'.',methods:true},{read:'/work'}];
  assert.equal(manage('$.permissions.set',{permissions:rules}).changed,true);
  assert.equal(manage('$.permissions.set',{permissions:[{methods:true,node:'.'},{read:'/work'}]}).changed,false);
  assert.equal(manage('$.permissions.set',{permissions:rules.reverse()}).changed,true);
  assert.deepEqual(manage('$.permissions.get').result,{permissions:rules});
  assert.deepEqual(manage('$.profile.scope.get').result,{scope:[true]});
  store.setStatus(profile.id,'working');
  const summary={id:profile.id,parentId:'~',name:'profile',type:'profile',status:'working'};
  assert.deepEqual(manage('$.node.get').result,summary);
  assert.deepEqual(store.visible(owner.id).find(n=>n.id===profile.id),summary);
});

test('membership writes authorize the selected member on the receiving TEAM', t=>{
  const db=new DatabaseSync(':memory:'); t.after(()=>db.close());
  const store=new Store(db);
  const team=store.create('~','team',{name:'target'});
  const profile=store.create('~','profile',{name:'profile'});
  const permissions=[{node:team.id,methods:{'$.team.members.*':{
    type:'object',required:['memberId'],properties:{memberId:{const:profile.id}}
  }}}];
  const user=store.create('~','user',{name:'operator',email:'operator@example.test',permissions});
  store.setStatus(user.id,'working');
  for (const op of ['add','remove']) {
    const manage=(data:unknown)=>store.manage(user.id,team.id,'$.team.members.'+op,data);
    assert.throws(()=>manage({memberId:user.id}),/Permission denied/);
    assert.throws(()=>manage({appId:profile.id}),/Permission denied/);
    assert.equal(manage({memberId:profile.id}).changed,true);
  }
  assert.equal(store.get(profile.id)?.parentId,'~');
});
