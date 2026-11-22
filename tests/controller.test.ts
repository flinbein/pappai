import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Controller } from '../src/controller.ts';
import { prepare } from '../src/manifest.ts';

const method = 'message.extractText';
const manifest = {
  run: {
    type: 'process',
    settings: {
      cwd: '/opt/example',
      command: 'node',
      args: ['extract.mjs'],
      features: {
        [method]: {
          type: 'method',
          description: '',
          version: '1',
          schema: { input: { type: 'object' }, output: { type: 'string' } },
        },
      },
    },
  },
  executors: { mode: 'oneShot', poolSize: 1 },
};
function fixture() {
  const node = { id: 'app', type: 'app', status: 'working', manifest };
  const store = {
    get: () => node,
    visible: () => [node],
    allows: (actor: string) => actor === 'owner',
    canDiscover: () => true,
    workingApps: () => [node],
    sandbox: () => null,
    setStatus: (_id, status) => {
      node.status = status;
    },
  };
  const runner = Object.assign(new EventEmitter(), {
    jobs: [],
    errors: [],
    dispatch(job) {
      this.jobs.push(job);
    },
    rejectReply(id, message) {
      this.errors.push({ id, message });
    },
  });
  return { runner, node, controller: new Controller(store, runner) };
}
test('forbidden, invalid version and invalid input are rejected before dispatch', async () => {
  const { controller, runner } = fixture();
  await assert.rejects(controller.call('other', { node: 'app', method }), /permission/i);
  await assert.rejects(controller.call('owner', { node: 'app', method, version: '2' }), /version/i);
  await assert.rejects(controller.call('owner', { node: 'app', method, data: 17 }), /schema/i);
  assert.equal(runner.jobs.length, 0);
  assert.throws(() => prepare({ ...manifest, executors: { mode: 'persistent' } }));
});
test('invalid reply leaves call open and output is accepted only once', async () => {
  const { controller, runner } = fixture();
  const pending = controller.call('owner', { node: 'app', method, data: { text: 'hello' } });
  const { id, appId } = runner.jobs[0];
  runner.emit('reply', { id, appId, result: 3 });
  assert.equal(runner.errors.length, 1);
  runner.emit('reply', { id, appId, result: 'hello' });
  runner.emit('exit', { id, appId });
  assert.equal(await pending, 'hello');
});
test('host loss terminates queued and assigned calls once and persists error', async () => {
  const { controller, runner, node } = fixture();
  const calls = Promise.allSettled([
    controller.call('owner', { node: 'app', method, data: {} }),
    controller.call('owner', { node: 'app', method, data: {} }),
  ]);
  assert.equal(runner.jobs.length, 1);
  runner.emit('lost', 'host exited');
  assert.ok((await calls).every((r) => r.status === 'rejected'));
  assert.equal(node.status, 'error');
  assert.equal(runner.jobs.length, 1);
});
test('timeout removes queued work; cancellation closes an assigned call without reusing its slot', async () => {
  const { controller, runner } = fixture();
  const signal = new AbortController();
  const params = { node: 'app', method, data: {} };
  const active = controller.call('owner', params, signal.signal);
  const expired = controller.call('owner', { ...params, timeoutMs: 5 });
  await assert.rejects(expired, /timed out/i);
  signal.abort();
  await assert.rejects(active, /cancelled/i);
  const next = controller.call('owner', params);
  assert.equal(runner.jobs.length, 1);
  const first = runner.jobs[0];
  runner.emit('reply', { ...first, result: 'late' });
  assert.equal(runner.errors.length, 1);
  runner.emit('exit', first);
  assert.equal(runner.jobs.length, 2);
  runner.emit('reply', { ...runner.jobs[1], result: 'done' });
  assert.equal(await next, 'done');
});
test('local schema references are validated without changing data', () => {
  const m = structuredClone(manifest);
  m.run.settings.features[method].schema.input = {
    $defs: { x: { type: 'integer' } },
    $ref: '#/$defs/x',
  };
  const f = prepare(m).features.get(method);
  assert.equal(f.input(1), true);
  assert.equal(f.input('1'), false);
});
test('only synchronous schemas can admit a call', () => {
  const m = structuredClone(manifest);
  m.run.settings.features[method].schema.input = { $async: true, type: 'integer' };
  assert.throws(() => prepare(m), /async/i);
});
