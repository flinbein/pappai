import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { request, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createService } from '../src/server.ts';

async function startWeb(t: TestContext, webRoot = '') {
  const origin = 'http://localhost:32393';
  const db = new DatabaseSync(':memory:');
  const s = createService({ db, origin, webRoot });
  t.after(async () => {
    await s.close();
    db.close();
  });
  s.server.listen(0, '127.0.0.1');
  await once(s.server, 'listening');
  const port = (s.server.address() as AddressInfo).port;
  return (path: string, method = 'GET', extra = {}) =>
    new Promise<{ status: number; body: string; headers: IncomingHttpHeaders }>((resolve, reject) => {
      const req = request({
        hostname: '127.0.0.1', port, path, method,
        headers: { Host: 'localhost:32393', Origin: origin, 'Content-Type': 'application/json', ...extra },
      }, res => {
        let body = '';
        res.setEncoding('utf8').on('data', chunk => body += chunk);
        res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }));
      });
      req.on('error', reject);
      req.end();
    });
}

test('bundled panel and assets are public; terminal and RPC retain their access checks', async t => {
  const send = await startWeb(t);
  const panel = await send('/');
  assert.equal(panel.status, 200);
  assert.match(panel.headers['content-type']!, /^text\/html/);
  assert.equal(panel.headers['cache-control'], 'no-store');
  assert.match(panel.headers['content-security-policy']!, /frame-ancestors 'none'/);
  const script = panel.body.match(/src="(\/_web\/[^/"]+\/assets\/[^"]+\.js)"/)?.[1];
  assert.ok(script, 'panel references a versioned JS asset');
  const asset = await send(script);
  assert.equal(asset.status, 200);
  assert.match(asset.headers['content-type']!, /javascript/);
  assert.match(asset.headers['cache-control']!, /immutable/);
  assert.equal(asset.headers['x-content-type-options'], 'nosniff');
  const terminal = await send('/terminal');
  assert.equal(terminal.status, 303);
  assert.equal(terminal.headers.location, '/');
  assert.equal((await send('/rpc', 'POST')).status, 401);
  assert.equal((await send('/rpc', 'POST', { Origin: 'https://other.example' })).status, 403);
  assert.equal((await send('/', 'GET', { Host: 'other.example' })).status, 404);
});

test('switching current changes the entry while retained assets keep their original bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pappai-web-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const send = await startWeb(t, root);
  const bundled = await send('/');
  assert.equal(bundled.status, 200);

  async function activate(version: string) {
    const dir = join(root, 'releases', version);
    await mkdir(join(dir, 'assets'), { recursive: true });
    await writeFile(join(dir, 'index.html'), `<script src="/_web/${version}/assets/panel.js"></script>`);
    await writeFile(join(dir, 'assets', 'panel.js'), JSON.stringify(version));
    await writeFile(join(root, 'next'), version + '\n');
    await rename(join(root, 'next'), join(root, 'current'));
  }
  await activate('3.0.0');
  assert.match((await send('/')).body, /\/_web\/3\.0\.0\//);
  await activate('3.1.0');
  assert.match((await send('/')).body, /\/_web\/3\.1\.0\//);
  for (const version of ['3.0.0', '3.1.0']) {
    const asset = await send(`/_web/${version}/assets/panel.js`);
    assert.equal(asset.status, 200);
    assert.equal(JSON.parse(asset.body), version);
  }
  for (const path of ['/_web/3.1.0/index.html', '/_web/3.1.0/terminal.html', '/_web/3.1.0/assets/../index.html',
    '/_web/3.1.0/assets/%2e%2e%2findex.html', '/_web/3.1.0/assets/missing.js', '/_web/9.9.9/assets/panel.js']) {
    const response = await send(path);
    assert.equal(response.status, 404, path);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  await rm(join(root, 'current'));
  assert.equal((await send('/')).body, bundled.body);
  assert.equal((await send('/_web/3.0.0/assets/panel.js')).status, 200);
});
