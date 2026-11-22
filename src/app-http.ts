import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type HttpJob = {
  id: string; appId: string; sandbox: unknown;
  settings: {env?: Record<string,string>};
  runtimeMounts?: {source:string;target:string;readonly:boolean}[];
};
const target = '/run/pappai/http';
export class AppHttpSockets {
  private dirs = new Map<string,string>();
  private current = new Map<string,string>();
  start(job: HttpJob) {
    if (process.platform !== 'linux') throw Error('Public HTTP executors require Linux');
    if (this.dirs.has(job.id)) throw Error('Duplicate HTTP executor');
    const dir = mkdtempSync(join(tmpdir(),'pappai-http-'));
    this.dirs.set(job.id,dir);
    this.current.set(job.appId,job.id);
    if (job.sandbox) (job.runtimeMounts ??= []).push({source:dir,target,readonly:false});
    // Assign a fresh environment object. Other slots may reuse this manifest snapshot.
    job.settings = {...job.settings,env:{...job.settings.env,
      PAPPAI_HTTP_SOCKET:join(job.sandbox ? target : dir,'app.sock')}};
  }
  retire(id: string) {
    for (const [app,worker] of this.current) if (worker === id) this.current.delete(app);
  }
  exit(id: string) {
    this.retire(id);
    const dir = this.dirs.get(id);
    this.dirs.delete(id);
    if (dir) rmSync(dir,{recursive:true,force:true});
  }
  socket(appId: string) {
    const dir = this.dirs.get(this.current.get(appId) ?? '');
    return dir ? join(dir,'app.sock') : null;
  }
  close() { for (const worker of this.dirs.keys()) this.exit(worker); }
}

function cleanHeaders(headers: IncomingHttpHeaders) {
  const clean = {...headers};
  for (const name of ['connection','upgrade','proxy-connection','proxy-authorization','proxy-authenticate',
    'keep-alive','trailer','te','transfer-encoding', ...(headers.connection ?? '').toLowerCase().split(',')])
    delete clean[name.trim()];
  return clean;
}
const panelCookie = /^(?:__Host-pappai-|pappai-local-)/i;
function proxy(req: IncomingMessage,res: ServerResponse,path: string) {
  // The APP owns the contents of its socket directory. Pin the socket itself so
  // replacing it with a symlink cannot redirect a privileged controller connect.
  let fd: number | undefined;
  const release = () => {
    if (fd !== undefined) closeSync(fd);
    fd = undefined;
  };
  try {
    if (process.platform === 'linux') {
      const O_PATH = 0x200000;
      fd = openSync(path,O_PATH | constants.O_NOFOLLOW);
      if (!fstatSync(fd).isSocket()) throw Error('Socket unavailable');
      path = '/proc/self/fd/' + fd;
    } else if (process.platform !== 'win32' && !lstatSync(path).isSocket()) throw Error('Socket unavailable');
    const headers = cleanHeaders(req.headers);
    if (headers.cookie) {
      const cookies = headers.cookie.split(';').map(v=>v.trim()).filter(v=>!panelCookie.test(v));
      if (cookies.length) headers.cookie = cookies.join('; ');
      else delete headers.cookie;
    }
    const upstream = request({socketPath:path,path:req.url,method:req.method,headers,agent:false},response => {
      const reply = cleanHeaders(response.headers);
      if (reply['set-cookie']) {
        reply['set-cookie'] = reply['set-cookie'].filter(cookie =>
          !panelCookie.test(cookie.trim()) && !/;\s*domain\s*=/i.test(cookie));
      }
      res.writeHead(response.statusCode ?? 502,reply);
      response.on('error',()=>res.destroy());
      response.pipe(res);
    });
    upstream.once('socket',socket=>socket.once('connect',release));
    upstream.once('close',release);
    upstream.once('error',()=>{
      release();
      if (res.destroyed) return;
      if (res.headersSent) res.destroy();
      else res.writeHead(503).end();
    });
    req.once('error',()=>upstream.destroy());
    res.once('close',()=>upstream.destroy());
    req.pipe(upstream);
  } catch {
    release();
    res.writeHead(503).end();
  }
}

const dnsLabel = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
export function createAppHttpRouter(template: string, panelHost: string,
    lookup: (name:string)=>string|null|undefined) {
  const parts = template.toLowerCase().split(/\{(?:name|id)\}/);
  const sample = parts.join('app');
  if (parts.length !== 2 || !new RegExp('^(?:' + dnsLabel + '\\.)*' + dnsLabel + '(?::[0-9]{1,5})?$').test(sample))
    throw Error('Invalid APP host template');
  const [prefix,suffix] = parts;
  const validName = new RegExp('^' + dnsLabel + '$');
  return (req: IncomingMessage,res: ServerResponse) => {
    const host = req.headers.host?.toLowerCase() ?? '';
    if (host === panelHost.toLowerCase() || !host.startsWith(prefix) || !host.endsWith(suffix)) {
      res.writeHead(404).end();
      return;
    }
    const name = host.slice(prefix.length,host.length-suffix.length);
    const path = validName.test(name) ? lookup(name) : undefined;
    if (!path) {
      res.writeHead(path === null ? 503 : 404).end();
      return;
    }
    proxy(req,res,path);
  };
}
