import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {EventEmitter} from 'node:events';
import {Controller} from '../src/controller.ts';
import {Store} from '../src/store.ts';
import {systemContract} from '../src/system-contract/index.ts';
import type {NodeType} from '../src/permits.ts';

// Listing a shared service is a promise to clients that have already learned its
// complete interface from a different node.
const serviceNames: Record<NodeType, string[]> = {
  workspace: ['workspace', 'children', 'runners'],
  team: ['node', 'permissions', 'children', 'team'],
  user: ['node', 'lifecycle', 'permissions', 'effectivePermissions', 'memberships', 'user'],
  app: ['node', 'lifecycle', 'permissions', 'effectivePermissions', 'memberships', 'subscriptions', 'app'],
  profile: ['node', 'lifecycle', 'permissions', 'effectivePermissions', 'memberships', 'profile'],
};

test('every node advertises complete, documented system interfaces', () => {
  const seen = new Map();
  for (const type of Object.keys(serviceNames) as NodeType[]) {
    const contract = systemContract(type);
    const roots = [...contract.keys()].filter(name => name.split('.').length === 2);
    assert.deepEqual(roots.sort(), serviceNames[type].map(name => '$.' + name).sort());
    for (const name of roots) {
      assert.equal(contract.get(name)?.type, 'document', name);
      const service = [...contract].filter(([key]) => key === name || key.startsWith(name + '.'));
      if (seen.has(name)) assert.deepEqual(service, seen.get(name), name);
      seen.set(name, service);
    }
    for (const [name, entry] of contract) {
      assert.ok(entry.description && entry.doc && entry.version, name);
      if (name.split('.').length > 2)
        assert.equal(contract.get(name.slice(0, name.lastIndexOf('.')))?.type, 'document', name);
      if (entry.type === 'method') {
        assert.ok(entry.schema?.input && entry.schema?.output && entry.input && entry.output, name);
      } else if (entry.type === 'event') {
        assert.ok(entry.schema?.data && entry.data, name);
      }
    }
  }
});

test('management schemas describe the entire replacement or change payload', () => {
  const permit = systemContract('app').get('$.permissions.set')!.input!;
  assert.equal(permit({permissions: null}), true);
  assert.equal(permit({permissions: [{node: ['!~', true], methods: {'$.team.members.add': {
    properties: {memberId: {node: './**', nodeType: 'user'}},
  }}}]}), true);
  const add = systemContract('app').get('$.subscriptions.add')!.input!;
  const subscriptions = [{id: 'started', events: '$.lifecycle.statusChanged'}];
  assert.equal(add({before: true, subscriptions}), true);
  assert.equal(add({subscriptions, before: 'first', after: 'other'}), false);
  const start = systemContract('profile').get('$.lifecycle.start')!.input!;
  assert.equal(start({force: true}), false);
  const member = systemContract('team').get('$.team.members.add')!.input!;
  assert.equal(member({memberId: 'someone'}), true);
  assert.equal(member({appId: 'someone'}), false);
});

test('help schemas describe actual responses on each supported node type', async t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const store = new Store(db);
  const admin = store.ensureAdmin('admin@example.org');
  const controller = new Controller(store, new EventEmitter() as never);
  const manifest = {run: {type: 'process', settings: {command: 'node', cwd: process.cwd(), features: {}}}, executors: {mode: 'oneShot'}};
  const app = store.create('~', 'app', {name: 'example', manifest});
  const team = store.create('~', 'team', {name: 'example'});
  const profile = store.create('~', 'profile', {name: 'example'});
  for (const node of [store.get('~')!, team, admin, app, profile]) {
    const entries = systemContract(node.type);
    const help = controller.help(admin.id, {node: node.id, features: true, doc: true, schema: true});
    for (const [name, entry] of entries) {
      assert.equal(help[name].doc, entry.doc, name);
      assert.deepEqual(help[name].schema, entry.schema, name);
      // Runner registrations need a running registry. All other get/list methods
      // in this fixture are provided directly by the controller and store.
      if (!entry.output || name === '$.runners.list' || !/\.(get|getApplied|list)$/.test(name)) continue;
      const result = await controller.call(admin.id, {node: node.id, method: name});
      assert.equal(entry.output(result), true, name + ' ' + JSON.stringify(result));
    }
  }
});
