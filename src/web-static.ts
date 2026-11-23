import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';

const require = createRequire(import.meta.url);
const webPackage = '@flinbein/pappai-web/package.json';
const bundledDist = join(dirname(require.resolve(webPackage)), 'dist');
const bundledVersion: string = require(webPackage).version;
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/;
const contentTypes: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

async function readOptional(path: string) {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function serveWeb(path: string, res: ServerResponse, releaseRoot?: string) {
  const entry = path === '/' ? 'index.html' : path === '/terminal' ? 'terminal.html' : undefined;
  if (!entry && !path.startsWith('/_web/')) return false;
  try {
    if (entry) {
      let dist = bundledDist;
      if (releaseRoot) {
        const pointer = await readOptional(join(releaseRoot, 'current'));
        if (pointer) {
          const version = pointer.toString('utf8').trim();
          if (!versionPattern.test(version)) throw Error('Invalid web release version');
          dist = join(releaseRoot, 'releases', version);
        }
      }
      const html = await readFile(join(dist, entry));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
      return true;
    }

    // Only generated filenames and version components can reach the filesystem.
    const asset = /^\/_web\/([^/]+)\/assets\/([a-zA-Z0-9_-][a-zA-Z0-9._-]*\.[a-zA-Z0-9]+)$/.exec(path);
    if (!asset || !versionPattern.test(asset[1])) {
      res.writeHead(404).end();
      return true;
    }
    const [, version, name] = asset;
    let content = releaseRoot
      ? await readOptional(join(releaseRoot, 'releases', version, 'assets', name))
      : undefined;
    if (!content && version === bundledVersion) content = await readOptional(join(bundledDist, 'assets', name));
    if (content) {
      res.writeHead(200, {
        'Content-Type': contentTypes[extname(name)] ?? 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable',
      }).end(content);
    } else {
      res.writeHead(404).end();
    }
  } catch (error) {
    console.error('Cannot serve web release', error);
    res.writeHead(503).end();
  }
  return true;
}
