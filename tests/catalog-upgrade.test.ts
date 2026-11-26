import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { catalogUpgradeFindings } from '../src/catalog-upgrade.ts';
import { Store } from '../src/store.ts';

test('catalog inventory locates grants, denies, dormant rules and both sides of a rename', t=>{
  const db=new DatabaseSync(':memory:'); t.after(()=>db.close());
  const store=new Store(db);
  const node=store.create('~','team',{name:'restricted',permissions:[
    {node:['!outside',true],methods:'$.app.**',deny:true},
    {methods:{'$.app.start':{type:'object',properties:{force:{const:true}}}}},
    {nodeType:'user',methods:'$.children.*'},
    {events:['notice','$.node.permissions.updated'],deny:true},
    {cli:true,read:'/data'},
  ]}).id;
  const findings=catalogUpgradeFindings(db);
  assert.equal(findings.length,4);
  assert.ok(findings.every(finding=>finding.node===node));
  assert.equal(findings[0].effect,'deny');
  assert.ok(findings[0].names.includes('$.app.memberships.add'));
  assert.ok(findings[0].names.includes('$.app.forceStart'));
  assert.deepEqual(findings[1].names,['$.app.start']);
  assert.ok(findings[2].names.includes('$.children.createTeam'));
  assert.deepEqual(findings[3],{node,location:'permissions[3].events',effect:'deny',names:['$.node.permissions.updated']});
});

test('read-only inventory checks applied, personal, inline and file override filters without exposing values', t=>{
  const directory=mkdtempSync(join(tmpdir(),'catalog-review-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const file=join(directory,'workspace.sqlite');
  const db=new DatabaseSync(file);
  const store=new Store(db);
  const manifest={subscriptions:[{events:'$.app.executor.failed'}]};
  const external=store.create('~','app',{name:'private-app',manifest}).id;
  const inline=store.create('~','app',{name:'another-private-app',manifest:{}}).id;
  store.setSubscriptions(external,[{id:'private-id',enabled:false,events:{'$.node.**':'*'},deny:true}]);
  db.exec('CREATE TABLE manifest_sources(appId TEXT PRIMARY KEY, source TEXT NOT NULL)');
  const source=db.prepare('INSERT INTO manifest_sources VALUES(?,?)');
  source.run(external,JSON.stringify({file:'/private-package/manifest.json',override:{subscriptions:[{events:true}]}}));
  source.run(inline,JSON.stringify({manifest:{subscriptions:[{events:{'$.subscriptions.changed':true}}]}}));
  db.close();

  const before=readFileSync(file);
  const output=execFileSync(process.execPath,['src/catalog-upgrade.ts',file],{encoding:'utf8'});
  const found=JSON.parse(output);
  assert.ok(found.some(f=>f.node===external && f.location==='manifest.subscriptions[0].events'));
  assert.ok(found.some(f=>f.node===external && f.location==='personal_subscriptions[0].events' &&
    f.effect==='deny' && f.names.includes('$.node.permissions.updated')));
  assert.ok(found.some(f=>f.node===external && f.location==='source.override.subscriptions[0].events'));
  assert.ok(found.some(f=>f.node===external && f.location==='source.file'));
  assert.ok(found.some(f=>f.node===inline && f.location==='source.manifest.subscriptions[0].events'));
  assert.doesNotMatch(output,/private/);
  assert.deepEqual(readFileSync(file),before);
});
