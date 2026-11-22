import { closeSync, constants as F, createReadStream, fstatSync, openSync, readlinkSync } from 'node:fs';
import { opendir } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { posix } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { minimalPaths } from './permits.ts';
import { sandboxPrivateTmp } from './sandbox.ts';
import type { Store } from './store.ts';

const O_PATH = 0x200000;
const fdPath = (fd: number) => '/proc/self/fd/' + fd;
const under = (path:string, base:string) => path === base || path.startsWith(base + '/');
const blocked = (path:string) => ['/proc','/dev','/sys','/run'].some(base => under(path,base));
const child = (base:string,name:string) => (base === '/' ? '' : base) + '/' + name;
const encode = (name:string) => encodeURIComponent(name).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16));
const link = (path:string) => '/files' + path.split('/').map(encode).join('/');
const html = (value:string) => value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));

class HttpError extends Error {
  status:number;
  constructor(status:number) { super('File request failed'); this.status=status; }
}

type View = {
  allows:(path:string)=>boolean; anchors:string[]; privateTmp?:string;
};

function requestedPath(url:string) {
  const raw = url.split('?')[0];
  if (raw === '/files') return '/';
  if (!raw.startsWith('/files/')) throw new HttpError(404);
  let path;
  try { path=decodeURIComponent(raw.slice('/files'.length)); } catch {throw new HttpError(400);}
  if (path.length > 4096 || path.includes('\0') || path.split('/').some(s=>s==='.' || s==='..') ||
      path.includes('//')) throw new HttpError(400);
  return path.length > 1 ? path.replace(/\/$/,'') : path;
}

function navigable(view:View,path:string) {
  return !blocked(path) && (view.allows(path) || view.anchors.some(a=>a.startsWith(child(path,''))));
}

// Read only names from symlinks. We interpret their contents in the USER's
// namespace, including absolute targets under private /tmp. Every ordinary
// component is pinned independently of subsequent directory-entry changes.
function pin(view:View,path:string,followLast=true):{fd:number; path:string} {
  if (!navigable(view,path)) throw new HttpError(403);
  const parts = path.split('/').filter(Boolean);
  const parents:number[] = [];
  const names:string[] = [];
  let current = openSync('/',O_PATH|F.O_DIRECTORY);
  let links=0;
  try {
    while (parts.length) {
      const name = parts.shift()!;
      if (name === '.') continue;
      if (name === '..') {
        if (parents.length) { closeSync(current); current=parents.pop()!; names.pop(); }
        continue;
      }
      const logical = '/' + [...names,name].join('/');
      if (blocked(logical)) throw new HttpError(403);
      const source = logical === '/tmp' && view.privateTmp ? view.privateTmp : fdPath(current)+'/'+name;
      const next = openSync(source,O_PATH|F.O_NOFOLLOW);
      const stat=fstatSync(next);
      if (stat.isSymbolicLink() && (parts.length || followLast)) {
        closeSync(next);
        if (++links > 40) throw new HttpError(403);
        const target=readlinkSync(source);
        const destination=posix.resolve('/'+names.join('/'),target,...parts);
        if (!navigable(view,destination)) throw new HttpError(403);
        if (target.startsWith('/')) {
          while (parents.length) {closeSync(current); current=parents.pop()!;}
          names.length=0;
        }
        parts.unshift(...target.split('/').filter(Boolean));
        continue;
      }
      if (parts.length && !stat.isDirectory()) {
        closeSync(next);
        throw Object.assign(Error('Not a directory'),{code:'ENOTDIR'});
      }
      parents.push(current); current=next; names.push(name);
    }
    const actual='/'+names.join('/');
    if (!navigable(view,actual)) throw new HttpError(403);
    const fd=current;
    current=-1;
    return {fd,path:actual};
  } finally {
    if (current >= 0) closeSync(current);
    for (const fd of parents) closeSync(fd);
  }
}

function absent(err:unknown) {return ['ENOENT','ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '');}

// Inspect only explicitly granted anchors. A forbidden physical parent is
// never enumerated, even when it contains other public-looking entries.
function synthetic(view:View,dir:string) {
  const names=new Set<string>();
  const prefix=child(dir,'');
  for (const a of view.anchors) {
    if (a===dir || !a.startsWith(prefix) || !view.allows(a) || blocked(a)) continue;
    const first=a.slice(prefix.length).split('/')[0];
    if (names.has(first)) continue;
    try {
      const {fd}=pin(view,a,false);
      closeSync(fd);
      names.add(first);
    } catch (err) {
      if (!absent(err) && !(err instanceof HttpError)) throw err;
    }
  }
  return names;
}

function entry(dir:string,name:string) {
  return '<li><a href="'+link(child(dir,name))+'">'+html(name)+'</a></li>\n';
}

async function* page(view:View,fd:number,requested:string,actual:string,syntheticEntries?:Set<string>) {
  const title=html(requested);
  yield '<!doctype html><html lang="ru"><meta charset="utf-8"><title>'+title+'</title><h1>'+title+'</h1><ul>\n';
  if (requested !== '/') yield '<li><a href="'+link(posix.dirname(requested))+'">../</a></li>\n';
  if (syntheticEntries) {
    for (const name of [...syntheticEntries].sort()) yield entry(requested,name);
  } else {
    for await (const item of await opendir(fdPath(fd))) {
      const src=child(requested,item.name), dest=child(actual,item.name);
      if (item.isSymbolicLink() || (!blocked(src) && !blocked(dest) &&
          ((view.allows(src) && view.allows(dest)) ||
           (item.isDirectory() && synthetic(view,dest).size && navigable(view,src))))) {
        yield entry(requested,item.name);
      }
    }
  }
  yield '</ul></html>';
}

export async function serveUserFiles(store:Store,actor:string,req:IncomingMessage,res:ServerResponse) {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  let pinned:number|undefined;
  try {
    if (req.method !== 'GET') {res.setHeader('Allow','GET'); throw new HttpError(405);}
    if (process.platform !== 'linux') throw new HttpError(503);
    const path=requestedPath(req.url ?? '');
    const {allows,sandbox}=store.fileSnapshot(actor);
    const view:View={allows,anchors:sandbox
      ? [...new Set([...minimalPaths,'/tmp',...sandbox.read,...sandbox.write])] : []};
    if (sandbox) view.privateTmp=sandboxPrivateTmp(actor);
    // For a nonexistent forbidden directory, existence itself stays private.
    const direct=view.allows(path) && !blocked(path);
    if (!direct && (!navigable(view,path) || !synthetic(view,path).size)) throw new HttpError(403);
    const object=pin(view,path);
    pinned=object.fd;
    const info=fstatSync(pinned);
    if (info.isDirectory()) {
      const entries=direct && view.allows(object.path) ? undefined : synthetic(view,object.path);
      if (entries && !entries.size) throw new HttpError(403);
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy',"default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      await pipeline(Readable.from(page(view,pinned,path,object.path,entries)),res);
    } else {
      if (!direct || !view.allows(object.path) || !info.isFile()) throw new HttpError(403);
      const fd=openSync(fdPath(pinned),F.O_RDONLY);
      const input=createReadStream('',{fd});
      res.setHeader('Content-Type','application/octet-stream');
      res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+encode(posix.basename(path)));
      res.setHeader('X-Pappai-File-Path',object.path.split('/').map(encode).join('/'));
      await pipeline(input,res);
    }
  } catch (err) {
    if (!res.destroyed && !res.headersSent) {
      const code = err instanceof HttpError ? err.status : absent(err) ? 404 : 500;
      res.writeHead(code).end();
    } else if (!res.destroyed) res.destroy();
  } finally { if (pinned !== undefined) closeSync(pinned); }
}
