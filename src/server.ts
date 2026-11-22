import { createServer, type IncomingMessage } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from './store.ts';
import { ProcessRunner } from './runner.ts';
import { Controller } from './controller.ts';
import { createAuth } from './auth.ts';
import { attachTerminals } from './terminal.ts';

const assets = new Map(
  Object.entries({
    '/': ['index.html', 'text/html'],
    '/app.js': ['app.js', 'text/javascript'],
    '/auth.js': ['auth.js', 'text/javascript'],
    '/style.css': ['style.css', 'text/css'],
    '/terminal': ['terminal.html', 'text/html'],
    '/terminal.js': ['terminal.js', 'text/javascript'],
    '/xterm.mjs': ['../node_modules/@xterm/xterm/lib/xterm.mjs', 'text/javascript'],
    '/xterm.css': ['../node_modules/@xterm/xterm/css/xterm.css', 'text/css'],
    '/fit.mjs': ['../node_modules/@xterm/addon-fit/lib/addon-fit.mjs', 'text/javascript'],
  }).map(([path, [name, type]]) => [
    path,
    { type, content: readFileSync(new URL('../public/' + name, import.meta.url)) },
  ]),
);

async function body(req: IncomingMessage) {
  const buffers: Buffer[] = [];
  let n = 0;
  for await (const chunk of req) {
    n += chunk.length;
    if (n > 1024 * 1024) throw Error('Request too large');
    buffers.push(chunk);
  }
  return JSON.parse(Buffer.concat(buffers).toString('utf8'));
}
export function createService({ db, origin }: { db: DatabaseSync; origin: string }) {
  const address = new URL(origin);
  const store = new Store(db);
  store.recoverInterruptedStops();
  const auth = createAuth(db, origin);
  const runner = new ProcessRunner();
  const controller = new Controller(store, runner);
  const server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    if (req.headers.host !== address.host) {
      res.writeHead(404).end();
      return;
    }
    let id = null;
    try {
      if (await auth.handle(req, res, path)) {
        if (path === '/auth/logout') terminals.checkSessions();
        return;
      }
      if (path === '/terminal') {
        if (!auth.user(req, false)) { res.writeHead(303, {Location: '/'}).end(); return; }
        res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
      }
      if (req.method === 'GET' && assets.has(path)) {
        const { type, content } = assets.get(path)!;
        res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' }).end(content);
        return;
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (path === '/session' && req.method === 'GET') {
        const actor = auth.user(req, false);
        const admin = !!actor && store.isAdmin(actor);
        res.end(JSON.stringify({ user: actor, canChooseSandbox: admin, canManageApps: admin }));
        return;
      }
      if (path !== '/rpc' || req.method !== 'POST') {
        res.writeHead(404).end();
        return;
      }
      if (req.headers.origin !== address.origin) {
        res.writeHead(403).end();
        return;
      }
      const actor = auth.user(req);
      if (!actor) {
        res.writeHead(401).end();
        return;
      }
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
        res.writeHead(415).end();
        return;
      }
      const request = await body(req);
      if (request?.jsonrpc !== '2.0' || !['string', 'number'].includes(typeof request.id))
        throw Error('Invalid JSON-RPC request');
      id = request.id;
      const params = request.params ?? {};
      const cancel = new AbortController();
      res.once('close', () => {
        if (!res.writableEnded) cancel.abort();
      });
      let result;
      switch (request.method) {
        case 'dir':
          result = store.visible(actor);
          break;
        case 'help':
          result = controller.help(actor, params);
          break;
        case 'call':
          result = await controller.call(actor, params, cancel.signal);
          break;
        default:
          throw Error('Unknown RPC method');
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: result ?? null }));
    } catch (error) {
      if (!res.destroyed && !res.writableEnded)
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: { code: -32000, message: (error as Error).message },
          }),
        );
    }
  });
  const terminals = attachTerminals(server, address, store, auth.user);
  async function close() {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await Promise.all([runner.close(), terminals.close()]);
    await closed;
  }
  return { server, store, controller, runner, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT ?? 3000);
  const origin = process.env.PAPPAI_ORIGIN ?? 'http://localhost:' + port;
  const file = resolve(process.env.PAPPAI_DB ?? 'data/pappai.sqlite');
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  const app = createService({ db, origin });
  app.server.listen(port, process.env.HOST ?? '127.0.0.1', () => console.log('pappai', origin));
  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    await app.close();
    db.close();
  }
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
