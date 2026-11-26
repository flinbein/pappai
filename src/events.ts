import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { Controller } from './controller.ts';
import { compileSubscriptions, changeSubscriptions } from './subscriptions.ts';
import type { Store } from './store.ts';

type UserSession = (req:IncomingMessage,touch?:boolean,expectedBrowserSession?:string)=>string|null;
const maxBuffered = 1024 * 1024;

export function isWebRpcSocket(path: string | undefined) {
  return path === '/ws/events' || /^\/api\/ws\/web(?:\?browserSession=[a-zA-Z0-9_-]+)?$/.test(path ?? '');
}

function validEvents(value: unknown) {
  return value === undefined || value === true || typeof value === 'string' ||
    (Array.isArray(value) && value.every(selector => typeof selector === 'string'));
}

export function attachEvents(server:Server, address:URL, store:Store, user:UserSession, controller:Controller) {
  const wss = new WebSocketServer({noServer:true,perMessageDeflate:false});
  const clients = new Map<WebSocket,()=>boolean>();
  let closing = false;
  server.on('upgrade',(req,socket,head)=>{
    if (!isWebRpcSocket(req.url)) return;
    const legacy = req.url === '/ws/events';
    const reject=(status:string)=>socket.end('HTTP/1.1 '+status+'\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    if (closing) return reject('503 Service Unavailable');
    if (req.headers.origin !== address.origin || req.headers.host !== address.host) return reject('403 Forbidden');
    const browserSession=new URL(req.url!,address).searchParams.get('browserSession') ?? undefined;
    const actor=user(req,false,browserSession);
    if (!actor) return reject('401 Unauthorized');
    wss.handleUpgrade(req,socket,head,ws=>{
      const life = new AbortController();
      const calls = new Map<string|number,AbortController>();
      let subscriptions:any[]=[];
      let filters=compileSubscriptions([],true);
      const valid=(touch = false)=>{
        if (user(req,touch) === actor) return true;
        ws.close(4401,'Session expired');
        life.abort();
        return false;
      };
      clients.set(ws,valid);
      const send=(value:object)=>{
        if (ws.readyState !== WebSocket.OPEN) return false;
        if (!valid()) return false;
        if (ws.bufferedAmount > maxBuffered) { ws.terminate(); return false; }
        try { ws.send(JSON.stringify(value)); return true; }
        catch { ws.terminate(); return false; }
      };
      const disconnect=controller.connectUser(actor,item=>{
        if (!valid()) return false;
        const matches=filters.filter(rule=>rule.enabled && store.selects(actor,item.from,rule.node ?? true) &&
          rule.matches(item.event!,item.data));
        if (!matches.length) return false;
        const routing = legacy ? {subscription:matches[0].id} : {subscriptionIds:matches.map(rule=>rule.id)};
        return send({jsonrpc:'2.0',method:'event',params:{...item,...routing}});
      });
      let alive=true;
      ws.on('pong',()=>{alive=true;});
      const heartbeat=setInterval(()=>{
        if (!valid()) return;
        if (!alive) return ws.terminate();
        alive=false;
        ws.ping();
      },15000);
      heartbeat.unref();
      ws.once('close',()=>{
        disconnect();
        clients.delete(ws);
        clearInterval(heartbeat);
        life.abort();
        calls.clear();
      });
      ws.on('error',()=>ws.terminate());
      ws.on('message',async (raw,binary)=>{
        if (!valid()) return;
        let id:string|number|null=null;
        let control:AbortController|undefined;
        try {
          if (binary) throw Error('Expected JSON-RPC text');
          const request=JSON.parse(raw.toString());
          if (request?.jsonrpc !== '2.0' || !['string','number'].includes(typeof request.id) ||
            typeof request.method !== 'string') throw Error('Invalid JSON-RPC request');
          id=request.id;
          if (calls.has(request.id)) throw Error('Duplicate active request id');
          if (!valid(true)) return;
          const params=request.params ?? {};
          let result;
          if (request.method.startsWith('subscriptions.')) {
            const action=request.method.slice('subscriptions.'.length);
            if(action==='get') result={subscriptions};
            else {
              if (!legacy && !['add','set','delete'].includes(action)) throw Error('Unknown subscription operation');
              if (action==='add' || action==='set') {
                if (!Array.isArray(params.subscriptions) || params.subscriptions.some((r:any)=>
                  !r || typeof r !== 'object' || Array.isArray(r) ||
                  Object.keys(r).some(key=>!['id','node','events'].includes(key)) ||
                  !(validEvents(r.events) || (legacy && r.events === false))))
                  throw Error('Invalid WebSocket subscription');
              }
              const next=changeSubscriptions(subscriptions,action === 'delete' ? 'remove' : action,params);
              filters=compileSubscriptions(next,true);
              subscriptions=next;
              result={};
            }
          } else switch(request.method) {
            case 'help': result=controller.help(actor,params); break;
            case 'discover': result=store.visible(actor); break;
            case 'publish':
              result=await controller.publish(actor,params,delivery=>send({jsonrpc:'2.0',method:'delivery',params:delivery}),life.signal);
              break;
            case 'call':
              if (calls.size >= 100) throw Error('Too many active calls');
              control=new AbortController();
              calls.set(request.id,control);
              result=await controller.call(actor,params,AbortSignal.any([control.signal,life.signal]));
              break;
            case 'cancel': {
              const pending=calls.get(params.id);
              if (!pending) throw Error('Call not found');
              pending.abort();
              result={};
              break;
            }
            default: throw Error('Unknown WebSocket method');
          }
          send({jsonrpc:'2.0',id,result:result ?? null});
        } catch (error) { send({jsonrpc:'2.0',id,error:{code:-32000,message:(error as Error).message}}); }
        finally { if (control && id !== null) calls.delete(id); }
      });
    });
  });
  return {
    checkSessions() { for (const valid of clients.values()) valid(); },
    close() {
      closing=true;
      for (const ws of clients.keys()) ws.terminate();
      wss.close();
    },
  };
}
