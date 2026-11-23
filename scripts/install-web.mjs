import { execFileSync } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const [version, directory] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || !directory || !process.env.npm_execpath) {
  throw Error('Usage: npm run web:install -- <stable-version> <web-release-directory>');
}
const root = resolve(directory);
const releases = join(root, 'releases');
await mkdir(releases, { recursive: true });
const stage = await mkdtemp(join(root, '.install-'));
try {
  const release = join(releases, version);
  try {
    await access(release);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const pkg = '@flinbein/pappai-web';
    const dist = join(stage, 'package', 'dist');
    const bundled = createRequire(import.meta.url).resolve(pkg + '/package.json');
    if (JSON.parse(await readFile(bundled, 'utf8')).version === version) {
      await cp(join(dirname(bundled), 'dist'), dist, {recursive: true});
    } else {
      const output = execFileSync(process.execPath, [process.env.npm_execpath, 'pack', pkg + '@' + version,
        '--ignore-scripts', '--json', '--registry=https://registry.npmjs.org'], { cwd: stage, encoding: 'utf8' });
      const [archive] = JSON.parse(output);
      if (archive.name !== pkg || archive.version !== version) throw Error('Unexpected web release');
      execFileSync('tar', ['-xzf', archive.filename, 'package/dist'], { cwd: stage });
    }
    await checkEntries(dist);
    try {
      await rename(dist, release);
    } catch (error) {
      if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
    }
  }
  await checkEntries(release);
  const pointer = join(stage, 'current');
  await writeFile(pointer, version + '\n');
  await rename(pointer, join(root, 'current'));
  console.log('Active pappai-web release: ' + version);
} finally {
  await rm(stage, { recursive: true, force: true });
}

async function checkEntries(dist) {
  for (const file of ['index.html', 'terminal.html']) {
    const html = await readFile(join(dist, file), 'utf8');
    const prefix = '/_web/' + version + '/assets/';
    const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]);
    if (!urls.some(url => url.endsWith('.js')) || !urls.every(url => url.startsWith(prefix))) {
      throw Error('Invalid release assets in ' + file);
    }
    for (const url of urls) await access(join(dist, 'assets', url.slice(prefix.length)));
  }
}
