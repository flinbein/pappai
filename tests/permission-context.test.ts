import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test, {type TestContext} from 'node:test';
import { Store } from '../src/store.ts';
import type { Permissions } from '../src/permits.ts';

function fixture(t:TestContext) {
  const db=new DatabaseSync(':memory:');
  t.after(()=>db.close());
  const store=new Store(db);
  const user=(name:string,permissions:Permissions)=>store.setStatus(store.create('~','user',{
    name,email:name+'@example.test',permissions,
  }).id,'working').id;
  const team=(name:string,permissions:Permissions,parent='~')=>store.create(parent,'team',{name,permissions}).id;
  return {store,user,team};
}

test('a foreign check uses the subject’s policy and reports one error for unavailable principals',t=>{
  const {store,user,team}=fixture(t);
  const subject=team('subject',[{node:'./**',methods:{save:{type:'number'}}}]);
  const target=team('target',[],subject);
  const hidden=user('hidden',null);
  const inspector=user('inspector',[{node:subject,checkPermissions:true}]);
  const action={type:'call',node:target,method:'save',data:42};
  assert.deepEqual(store.checkPermissions(inspector,{action}),{allowed:false});
  assert.deepEqual(store.checkPermissions(inspector,{subject,action}),{allowed:true});
  assert.deepEqual(store.checkPermissions(inspector,{subject,action:{...action,data:'42'}}),{allowed:false});
  const profile=store.create('~','profile',{name:'profile'}).id;
  const app=store.create('~','app',{name:'app',manifest:{},profile}).id;
  store.setStatus(app,'working');
  // This inspector can select the APP, but its bound PROFILE is inactive.
  const all=user('all',[{checkPermissions:true}]);
  for (const [actor,id] of [[inspector,hidden],[all,'missing'],[all,profile],[all,app],[all,'~']]) {
    assert.throws(()=>store.checkPermissions(actor,{subject:id,action}),{message:'Permission denied'});
    assert.throws(()=>store.restrict(actor,undefined,[id]),{message:'Permission denied'});
  }
  assert.throws(()=>store.restrict(inspector,undefined,[hidden],[{unknown:true}]),{message:'Permission denied'});
});

test('one request checks subjects together and nested requests revalidate the inherited check rights',t=>{
  const {store,user,team}=fixture(t);
  const second=team('second',[{methods:true}]);
  const first=user('first',[{node:second,checkPermissions:true},{methods:'save'}]);
  const third=user('third',[{methods:true}]);
  const actor=user('actor',[{checkPermissions:true,methods:true}]);
  const inherited=store.restrict(actor,undefined,[first],[{checkPermissions:true,methods:{save:{type:'integer'}}}]);
  assert.strictEqual(store.restrict(actor,inherited,[],null),inherited);
  const nested=store.restrict(actor,inherited,[second]);
  assert.equal(store.contextAllows(actor,nested,third,'methods','save',1),true);
  assert.equal(store.contextAllows(actor,nested,third,'methods','save','x'),false);
  assert.equal(store.contextAllows(actor,nested,third,'methods','remove',1),false);
  assert.throws(()=>store.restrict(actor,inherited,[third]),/Permission denied/);
  const group=store.restrict(actor,undefined,[first,third],[]);
  assert.deepEqual(store.visible(actor,group),[]);
  assert.throws(()=>store.restrict(actor,group,[second]),/Permission denied/);
  store.manage('~',first,'$.permissions.set',{permissions:[{methods:true}]});
  assert.throws(()=>store.contextAllows(actor,nested,third,'methods','save',1),/Permission denied/);
  assert.throws(()=>store.fileSnapshot(actor,nested),/Permission denied/);
});

test('directories intersect direct discoveries before adding ancestors; inline selectors retain the caller',t=>{
  const {store,user,team}=fixture(t);
  const parent=team('parent',null);
  const left=team('left',[],parent), right=team('right',[],parent);
  const subject=user('subject',[{node:left,discover:true},{node:'@',methods:'subjectSelf'}]);
  const actor=user('actor',[{node:[right,subject],discover:true},{checkPermissions:true,methods:true}]);
  const restricted=store.restrict(actor,undefined,[subject]);
  assert.deepEqual(store.visible(actor,restricted),[]);
  assert.equal(store.contextAllows(actor,restricted,subject,'methods','subjectSelf'),true);
  assert.equal(store.contextAllows(actor,restricted,actor,'methods','subjectSelf'),false);
  const self=store.restrict(actor,undefined,[],[{node:'.',methods:true}]);
  assert.equal(store.contextAllows(actor,self,actor,'methods','x'),true);
  assert.equal(store.contextAllows(actor,self,subject,'methods','x'),false);
  const visitor=store.restrict('~',undefined,[subject]);
  assert.deepEqual(store.visible('~',visitor).map(n=>n.id),['~',parent,left]);
});

test('TEAM callers, action data and strict workspace administrator checks match operation policy',t=>{
  const {store,user,team}=fixture(t);
  const target=team('target',null);
  const actor=team('actor',[{node:target,cli:{login:{type:'object',properties:{args:true},required:['args']}},events:'alarm',delivery:true},
    {node:'~',methods:true},{network:true},{node:'@',http:true}]);
  const allowed=(action:unknown)=>store.checkPermissions(actor,{action}).allowed;
  assert.equal(allowed({type:'cli',node:target,method:'login',input:{args:[]}}),true);
  assert.equal(allowed({type:'cli',node:target,method:'login',input:{}}),false);
  assert.equal(allowed({type:'event',node:target,event:'alarm'}),true);
  assert.equal(allowed({type:'delivery',node:target}),true);
  assert.equal(allowed({type:'network'}),true);
  assert.equal(allowed({type:'http'}),true);
  for (const method of ['runners.codex.install','$.runners.list']) {
    assert.equal(allowed({type:'call',node:'~',method}),false);
    const broad=store.restrict('~',undefined,[],[{methods:true}]);
    assert.equal(store.contextAllows('~',broad,'~','methods',method,{}),false);
    assert.equal(store.contextAllows('~',store.restrict('~',undefined,[target]),'~','methods',method,{}),true);
  }
  const inspector=user('creator',[{node:'~',methods:{'$.children.createTeam':{type:'object',properties:{permissions:true},required:['permissions']}}}]);
  assert.equal(store.checkPermissions(inspector,{action:{type:'call',node:'~',method:'$.children.createTeam',data:{name:'new'}}}).allowed,true);
});

test('launch files and network intersect the participants, inline rules and the actual parent mounts',t=>{
  const {store,user,team}=fixture(t);
  const actor=user('actor',null);
  const subject=team('subject',[{read:'/workspace',write:'/workspace/out',network:true}]);
  const ctx=store.restrict(actor,undefined,[subject],[{write:'/workspace',network:true}]);
  const ceiling={read:['/workspace/out/readonly'],write:['/workspace/out'],hide:['/workspace/out/private'],network:false};
  const view=store.fileSnapshot(actor,ctx,ceiling);
  assert.equal(view.sandbox?.network,false);
  assert.equal(view.allows('/workspace/other'),false);
  assert.equal(view.allows('/workspace/out/data',true),true);
  assert.equal(view.allows('/workspace/out/readonly/input'),true);
  assert.equal(view.allows('/workspace/out/readonly/input',true),false);
  assert.equal(view.allows('/workspace/out/private/file'),false);
  assert.equal(view.allows('/usr/bin/example'),true);
  assert.equal(view.allows('/tmp/task',true),true);
  assert.equal(view.allows('/proc/self'),false);
  const minimal={read:[],write:[],network:false};
  assert.deepEqual(store.fileSnapshot(actor,undefined,minimal).sandbox,minimal);
  assert.deepEqual(store.checkPermissions(actor,{action:{type:'write',path:'/workspace/out/x'}},ctx,minimal),{allowed:false});
});
