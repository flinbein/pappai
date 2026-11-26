import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertRunnerName, runnerDirectory, withRunnerLock } from './runner-storage.mjs';

function sourceArguments(args) {
  const [action, type, name, spec, ref] = args;
  if (!['add', 'update'].includes(action) || !['npm', 'git'].includes(type) ||
      args.length < 4 || args.length > (type === 'git' ? 5 : 4)) {
    throw Error('Usage: prepare-runner.mjs <add|update> <npm|git> <name> <source> [git-ref]');
  }
  assertRunnerName(name);
  if (typeof spec !== 'string' || spec.length > 2048 || /[\u0000-\u001f\u007f]/.test(spec)) throw Error('Invalid runner source');
  if (type === 'npm') {
    const match = /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:@([a-zA-Z0-9*~^<>=][a-zA-Z0-9.*~^<>= +|-]*))?$/.exec(spec);
    if (!match) throw Error('Expected npm package name with optional version, range or tag');
    return { action, name, source: { type, spec }, packageName: match[1] };
  }
  const url = URL.parse(spec);
  if (!url || !spec.startsWith('https://') || /[\\\s]/.test(spec) || !url.hostname || url.pathname === '/' ||
      url.username || url.password || url.search || url.hash) throw Error('Expected HTTPS Git repository URL without credentials, query or fragment');
  if (ref !== undefined && (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,254}$/.test(ref) || ref.includes('..') || ref.endsWith('/'))) {
    throw Error('Invalid Git ref');
  }
  return { action, name, source: { type, spec, ...(ref && { ref }) } };
}

function regularFile(root, path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || win32.isAbsolute(path) ||
      path.includes('\\') || path.includes('\0') || path.split('/').includes('..')) throw Error('Invalid package file path');
  const file = resolve(root, path);
  if (!file.startsWith(resolve(root) + sep)) throw Error('Package file is outside the package directory');
  runnerDirectory(dirname(file));
  if (!lstatSync(file).isFile()) throw Error('Expected a regular file: ' + file);
  return file;
}

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

function install(release, source, packageName, execute) {
  const { type, spec, ref } = source;
  let pkg;
  const flags = ['--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'];
  if (type === 'npm') {
    writeFileSync(join(release, 'package.json'), '{"private":true}\n');
    execute('npm', ['install', '--prefix', release, ...flags, '--', spec], release);
    pkg = join(release, 'node_modules', packageName);
  } else {
    pkg = join(release, 'package');
    mkdirSync(pkg);
    execute('git', ['init', '--quiet'], pkg);
    execute('git', ['fetch', '--depth=1', '--no-tags', '--', spec, ref ?? 'HEAD'], pkg);
    execute('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], pkg);
    regularFile(pkg, 'package.json');
    if (lstatSync(join(pkg, 'node_modules'), { throwIfNoEntry: false })) throw Error('Git source must omit node_modules');
    const lock = ['npm-shrinkwrap.json', 'package-lock.json'].find(file => lstatSync(join(pkg, file), { throwIfNoEntry: false }));
    if (lock) regularFile(pkg, lock);
    execute('npm', [lock ? 'ci' : 'install', '--prefix', pkg, ...flags], pkg);
  }
  const manifest = JSON.parse(readFileSync(regularFile(pkg, 'package.json'), 'utf8'));
  if (type === 'npm' && manifest.name !== packageName) throw Error('Unexpected npm package name');
  const entrypoint = regularFile(pkg, manifest.pappai?.runner ?? manifest.main);
  return relative(release, entrypoint).split(sep).join('/');
}

function releaseHint(releases) {
  // After terminal preparation the operator can still need to register the module.
  runnerDirectory(releases);
  for (const id of readdirSync(releases).reverse()) {
    const release = join(releases, id);
    if (!lstatSync(release).isDirectory()) continue;
    const metadata = JSON.parse(readFileSync(regularFile(release, 'source.json'), 'utf8'));
    return ' Register the existing release using the custom path: ' + regularFile(release, metadata.entrypoint);
  }
  return '';
}

export async function prepareRunner(root, args, execute = run) {
  const { action, name, source, packageName } = sourceArguments(args);
  return withRunnerLock(root, name, () => {
    const destination = join(root, name);
    const existing = lstatSync(destination, { throwIfNoEntry: false });
    if (existing) runnerDirectory(destination);
    const fresh = !existing || !readdirSync(destination).length;
    const releases = join(destination, 'releases');
    if (!fresh) {
      const marker = join(destination, '.pappai-runner');
      const managed = lstatSync(marker, { throwIfNoEntry: false })?.isFile() && readFileSync(marker, 'utf8') === name + '\n';
      if (!managed) throw Error('Runner directory is already in use: ' + destination);
      if (action === 'add') throw Error('Runner directory is already prepared.' + releaseHint(releases));
      runnerDirectory(releases);
    }
    const stage = mkdtempSync(join(root, '.prepare-' + name + '-'));
    try {
      const id = randomUUID();
      const stagedReleases = join(stage, 'releases');
      const release = join(stagedReleases, id);
      mkdirSync(release, { recursive: true, mode: 0o700 });
      const entrypoint = install(release, source, packageName, execute);
      writeFileSync(join(release, 'source.json'), JSON.stringify({ ...source, entrypoint }) + '\n', { flag: 'wx', mode: 0o600 });
      if (fresh) {
        writeFileSync(join(stage, '.pappai-runner'), name + '\n', { flag: 'wx', mode: 0o600 });
        if (existing) rmdirSync(destination); // Succeeds only while still empty.
        renameSync(stage, destination);
      } else {
        renameSync(release, join(releases, id));
      }
      return { entrypoint: join(releases, id, entrypoint) };
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await prepareRunner('/run/pappai/private/runners', process.argv.slice(2));
    // npm's TTY progress indicator may clear its line without printing a newline.
    console.log('\nPAPPAI_RESULT ' + JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
