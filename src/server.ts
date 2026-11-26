import { createServer, type IncomingMessage } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from './store.ts';
import { RunnerRegistry, registryMethods } from './runner-registry.ts';
import { initTempRoot } from './sandbox.ts';
import { AppHttpSockets, createAppHttpRouter } from './app-http.ts';
import { ManifestSources } from './manifest-sources.ts';
import { FileDelegations } from './file-delegations.ts';
import { serveUserFiles } from './file-browser.ts';
import { attachEvents } from './events.ts';
import { Controller } from './controller.ts';
import { createAuth } from './auth.ts';
import { attachTerminals } from './terminal.ts';
import { isWebPage, serveWeb } from './web-static.ts';

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
export function createService({ db, origin, webRoot = process.env.PAPPAI_WEB_ROOT, runnerRoot }: {
  db: DatabaseSync; origin: string; webRoot?: string; runnerRoot?:string;
}) {
  const address = new URL(origin);
  const store = new Store(db);
  store.recoverInterruptedStops();
  const auth = createAuth(db, origin);
  initTempRoot();
  const runner = new RunnerRegistry(store,runnerRoot);
  const files = new FileDelegations(store);
  const sockets = new AppHttpSockets();
  let sources: ManifestSources;
  const controller = new Controller(store, runner, {
    executorStart(job) {
      const codex=runner.isCodex(job.runnerType ?? 'process');
      const fileSocket=files.socketFor(job.id,job.appId,codex);
      if (fileSocket && !codex) {
        const destination='/run/pappai/files';
        if (job.sandbox) (job.runtimeMounts ??= []).push({source:fileSocket,target:destination,readonly:true});
        job.settings={...job.settings,env:{...job.settings.env,PAPPAI_FILES_SOCKET:job.sandbox ? destination : fileSocket}};
      }
      if (job.runnerType==='process' && job.mode==='persistent' && store.get(job.appId)?.httpName && store.hasHttp(job.appId)) sockets.start(job);
    },
    executorProfileRevoked:id=>files.revokeView(id),
    executorRetire(id) { sockets.retire(id); },
    executorExit(id,appId) {
      files.executorExit(id);
      sockets.exit(id);
      sources.applyPending(appId);
    },
    callOpened:files.callOpened.bind(files), callAssigned:files.callAssigned.bind(files),
    callClosed:files.callClosed.bind(files), unfinished:files.unfinished.bind(files),
    executorRequest:files.executorRequest.bind(files),
    manifestChanged:id=>sources.manifestChanged(id), beforeRestart:id=>sources.applyPending(id),
    profileFeatures:()=>runner.profileFeatures(),
    workspaceFeatures:()=>runner.workspaceFeatures(),
    workspaceCall:(...args)=>runner.workspaceCall(...args),
    isCodex:name=>runner.isCodex(name),
    profileCall:(...args)=>runner.profileCall(...args),
    systemNames:type=>type==='workspace'?registryMethods:type==='user'?['$.user.recovery.send']:[],
    system(actor,node,method,data) {
      const registry=runner.system(actor,node.id,method,data);
      if (registry.handled) return registry;
      if (method==='$.user.recovery.send' && node.type==='user')
        return {handled:true,result:auth.requestMail(actor,node.id)};
      if(method==='$.app.start' && node.type==='app' && !runner.available((node.manifest as any)?.run?.type))
        throw Error('Runner unavailable');
      return sources.system(actor,node,method,data);
    },
  });
  runner.setProfileReader((actor,path,worker)=>{
    if (store.get(actor)?.status!=='working' || (worker && !controller.isCurrentExecutor(actor,worker)))
      throw Error('Inactive caller');
    return files.readProfileFile(actor,path,worker);
  });
  sources = new ManifestSources(store,{
    validateSettings:(name,settings)=>runner.validateSettings(name,settings),
    hasRunner:name=>runner.has(name), isPersistentRunning:id=>controller.isPersistentRunning(id),
    apply:(id,manifest)=>controller.applyManifest(id,manifest),
    failed:(id,issue)=>controller.manifestFailed(id,issue),
    changed:id=>controller.emitSystem(id,'$.app.manifest.sourceChanged',{},id),
    created:id=>controller.emitSystem(id,'$.node.created',{status:'stopped'}),
  });
  runner.on('restarted',name=>controller.runnerRestarted(name));
  const initialized=runner.initialized.then(()=>{
    sources.restore();
    controller.emitSystem('~','$.workspace.init',{});
  });
  const template=process.env.PAPPAI_APP_HOST_TEMPLATE;
  const routeApp=template && createAppHttpRouter(template,address.host,name=>{
    const app=store.getByHttpName(name);
    if(!app) return undefined;
    if(app.status!=='working') return null;
    return store.hasHttp(app.id) ? sockets.socket(app.id) : undefined;
  });
  const server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.headers.host !== address.host) {
      if (routeApp) routeApp(req,res);
      else res.writeHead(404).end();
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // The embedded terminal creates style elements in whichever page opened the workspace.
    const terminalStyles = req.method === 'GET' && isWebPage(path) ? "; style-src 'self' 'unsafe-inline'" : '';
    const formAction = path === '/terminal' ? "'none'" : "'self'";
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action " +
      formAction + terminalStyles);

    let id = null;
    try {
      const apiPath = path.startsWith('/api/') ? path.slice('/api'.length) : path;
      if (await auth.handle(req, res, apiPath)) {
        if (apiPath === '/auth/logout') { terminals.checkSessions(); events.checkSessions(); }
        return;
      }
      if (path === '/files' || path.startsWith('/files/')) {
        const actor=auth.user(req);
        if(!actor) { res.writeHead(401).end(); return; }
        await serveUserFiles(store,actor,req,res);
        return;
      }
      if (path === '/terminal' && !auth.user(req, false)) { res.writeHead(303, {Location: '/'}).end(); return; }
      if (path !== '/api' && !path.startsWith('/api/') && req.method === 'GET' && await serveWeb(path, res, webRoot)) return;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (apiPath === '/session' && req.method === 'GET') {
        const actor = auth.user(req, false);
        const admin = !!actor && store.isAdmin(actor);
        res.end(JSON.stringify({ user: actor, canChooseSandbox: admin, canManageApps: admin }));
        return;
      }
      if (apiPath !== '/rpc' || req.method !== 'POST') {
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
        case 'discover':
          result = store.visible(actor);
          break;
        case 'help':
          result = controller.help(actor, params);
          break;
        case 'publish':
          result = await controller.publish(actor, params, undefined, cancel.signal);
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
  const events = attachEvents(server,address,store,auth.user,controller);
  async function close() {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    events.close();
    sources.close();
    controller.shutdown();
    server.closeAllConnections();
    await Promise.all([runner.close(), terminals.close(), auth.close()]);
    files.close();
    sockets.close();
    await closed;
  }
  return { server, store, controller, runner, initialized, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT ?? 3000);
  const origin = process.env.PAPPAI_ORIGIN ?? 'http://localhost:' + port;
  const file = resolve(process.env.PAPPAI_DB ?? 'data/pappai.sqlite');
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  const app = createService({ db, origin });
  await app.initialized;
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
