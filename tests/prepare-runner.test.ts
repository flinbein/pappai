import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { prepareRunner } from '../scripts/prepare-runner.mjs';
import { withRunnerLock } from '../scripts/runner-storage.mjs';

function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pappai-install-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'private', 'runners');
}

function populateNpm(manifest = { main: 'host.mjs' }) {
  return (command, args, cwd) => {
    assert.equal(command, 'npm');
    assert.ok(args.includes('--ignore-scripts'));
    const pkg = join(cwd, 'node_modules', '@example', 'runner');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@example/runner', ...manifest }));
    writeFileSync(join(pkg, 'host.mjs'), 'export {};');
  };
}

const npmArgs = ['npm', 'fixture', '@example/runner@latest'];

test('add prepares only empty destinations and reports a prepared entrypoint on retry', async t => {
  const root = workspace(t);
  mkdirSync(join(root, 'fixture'), { recursive: true });
  const { entrypoint } = await prepareRunner(root, ['add', ...npmArgs], populateNpm());
  const release = join(root, 'fixture', 'releases', readdirSync(join(root, 'fixture', 'releases'))[0]);
  const metadata = JSON.parse(readFileSync(join(release, 'source.json'), 'utf8'));
  assert.equal(metadata.type, 'npm');
  assert.equal(metadata.spec, npmArgs[2]);
  assert.equal(metadata.entrypoint, relative(release, entrypoint).split('\\').join('/'));
  await assert.rejects(prepareRunner(root, ['add', ...npmArgs], populateNpm()), error =>
    error.message.includes(entrypoint) && error.message.includes('path'));
  const next = await prepareRunner(root, ['update', ...npmArgs], populateNpm({ pappai: { runner: 'host.mjs' } }));
  assert.notEqual(next.entrypoint, entrypoint);
  assert.ok(existsSync(entrypoint));
  await assert.rejects(prepareRunner(root, ['update', ...npmArgs], populateNpm({ main: '../package.json' })));
  assert.equal(readdirSync(join(root, 'fixture', 'releases')).length, 2);
});

test('installers reject shared content, unsafe input and symlink destinations', async t => {
  const root = workspace(t);
  const legacy = join(root, 'fixture');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'legacy'), 'keep');
  for (const verb of ['add', 'update']) {
    await assert.rejects(prepareRunner(root, [verb, ...npmArgs], populateNpm()));
    assert.deepEqual(readdirSync(legacy), ['legacy']);
  }
  for (const args of [
    ['add', 'npm', '../outside', 'runner'], ['add', 'npm', 'runner', '--prefix=/tmp'],
    ['add', 'npm', 'runner', 'file:../package'], ['add', 'git', 'runner', 'ext::command'],
    ['add', 'git', 'runner', 'https://user:pwd@example.org/git'], ['add', 'git', 'runner', 'https://example.org/git', '-flag'],
  ]) await assert.rejects(prepareRunner(root, args, () => assert.fail('unexpected command')));
  const outside = join(dirname(root), 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(root, 'linked'), 'junction');
  await assert.rejects(prepareRunner(root, ['add', 'npm', 'linked', 'runner'], populateNpm()));
  assert.deepEqual(readdirSync(outside), []);
});

test('a failed initial install can retry and same-name preparations are serialized', async t => {
  const root = workspace(t);
  await assert.rejects(prepareRunner(root, ['add', ...npmArgs], populateNpm({ main: '/outside' })));
  await withRunnerLock(root, 'fixture', async () => {
    await assert.rejects(prepareRunner(root, ['add', ...npmArgs], populateNpm()), /in progress/);
  });
  assert.ok(existsSync((await prepareRunner(root, ['add', ...npmArgs], populateNpm())).entrypoint));
});

test('Git prepares the selected tag and installs locked dependencies from that checkout', async t => {
  const root = workspace(t);
  const repository = join(root, '..', 'git-fixture');
  mkdirSync(repository, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: repository, stdio: 'pipe' });
  git('init', '--quiet');
  writeFileSync(join(repository, 'package.json'), JSON.stringify({ main: 'missing', pappai: { runner: 'host.cjs' } }));
  writeFileSync(join(repository, 'package-lock.json'), '{}');
  writeFileSync(join(repository, 'host.cjs'), '// version one');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'first');
  git('tag', 'v1');
  writeFileSync(join(repository, 'host.cjs'), '// version two');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qam', 'next');
  const url = 'https://fixture.example.test/runner.git';
  const result = await prepareRunner(root, ['add', 'git', 'myhost', url, 'v1'], (command, args, cwd) => {
    if (command === 'git') execFileSync(command, ['-c', 'url.' + repository + '.insteadOf=' + url, ...args], { cwd, stdio: 'pipe' });
    else {
      assert.equal(command, 'npm');
      assert.equal(args[0], 'ci');
      assert.ok(args.includes('--ignore-scripts'));
    }
  });
  assert.equal(readFileSync(result.entrypoint, 'utf8'), '// version one');
  assert.deepEqual(JSON.parse(readFileSync(join(dirname(dirname(result.entrypoint)), 'source.json'), 'utf8')),
    { type: 'git', spec: url, ref: 'v1', entrypoint: 'package/host.cjs' });
});
