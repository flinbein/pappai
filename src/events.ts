import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { Controller } from './controller.ts';
import { compileSubscriptions, changeSubscriptions } from './subscriptions.ts';
import type { Store } from './store.ts';

type UserSession = (req:IncomingMessage,touch?:boolean)=>string|null;
const maxBuffered = 1024 * 1024;

export function attachEvents(server:Server, address:URL, store:Store, user:UserSession, controller:Controller) {
  const wss = new WebSocketServer({noServer:true,perMessageDeflate:false,maxPayload:65536});
  const clients = new Map<WebSocket,()=>boolean>();
  let closing = false;
  server.on('upgrade',(req,socket,head)=>{
    if (req.url !== '/ws/events') return;
    const reject=(status:string)=>socket.end('HTTP/1.1 '+status+'\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    if (closing) return reject('503 Service Unavailable');
    if (req.headers.origin !== address.origin || req.headers.host !== address.host) return reject('403 Forbidden');
    const actor=user(req);
    if (!actor) return reject('401 Unauthorized');
    wss.handleUpgrade(req,socket,head,ws=>{
      const life = new AbortController();
      const calls = new Map<string|number,AbortController>();
      let subscriptions:any[]=[];
      let filters=compileSubscriptions([],true);
      const valid=()=>user(req,false) === actor;
      clients.set(ws,valid);
      const send=(value:object)=>{
        if (ws.readyState !== WebSocket.OPEN) return false;
        if (!valid() || ws.bufferedAmount > maxBuffered) { ws.terminate(); return false; }
        try { ws.send(JSON.stringify(value)); return true; }
        catch { ws.terminate(); return false; }
      };
      const disconnect=controller.connectUser(actor,item=>{
        if (!valid()) { ws.terminate(); return false; }
        const filter=filters.find(rule=>rule.enabled && store.selects(actor,item.from,rule.node ?? true) &&
          rule.matches(item.event!,item.data));
        return !!filter && send({jsonrpc:'2.0',method:'event',params:{...item,subscription:filter.id}});
      });
      let alive=true;
      ws.on('pong',()=>{alive=true;});
      const heartbeat=setInterval(()=>{
        if (!alive || !valid()) return ws.terminate();
        alive=false;
        ws.ping();
      },15000);
      heartbeat.unref();
      ws.once('close',()=>{
        disconnect();
        clients.delete(ws);
        clearInterval(heartbeat);
        life.abort();
        for (const call of calls.values()) call.abort();
        calls.clear();
      });
      ws.on('error',()=>ws.terminate());
      ws.on('message',async (raw,binary)=>{
        if (!valid()) return ws.terminate();
        let id:string|number|null=null;
        let control:AbortController|undefined;
        try {
          if (binary) throw Error('Expected JSON-RPC text');
          const request=JSON.parse(raw.toString());
          if (request?.jsonrpc !== '2.0' || !['string','number'].includes(typeof request.id) ||
            typeof request.method !== 'string') throw Error('Invalid JSON-RPC request');
          id=request.id;
          if (calls.has(request.id)) throw Error('Duplicate active request id');
          const params=request.params ?? {};
          let result;
          if (request.method.startsWith('subscriptions.')) {
            const action=request.method.slice('subscriptions.'.length);
            if(action==='get') result={subscriptions};
            else {
              if (action==='add' || action==='set') {
                if (!Array.isArray(params.subscriptions) || params.subscriptions.some((r:any)=>
                  !r || typeof r !== 'object' || Object.keys(r).some(key=>!['id','node','events'].includes(key)) ||
                  (r.events !== undefined && typeof r.events === 'object' && !Array.isArray(r.events))))
                  throw Error('Invalid WebSocket subscription');
              }
              const next=changeSubscriptions(subscriptions,action,params);
              filters=compileSubscriptions(next,true);
              subscriptions=next;
              result={};
            }
          } else switch(request.method) {
            case 'help': result=controller.help(actor,params); break;
            case 'dir': result=store.visible(actor); break;
            case 'publish':
              result=await controller.publish(actor,params,delivery=>send({jsonrpc:'2.0',method:'delivery',params:delivery}),life.signal);
              break;
            case 'call':
              if (calls.size >= 100) throw Error('Too many active calls');
              control=new AbortController();
              calls.set(request.id,control);
              result=await controller.call(actor,params,control.signal);
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
          send({jsonrpc:'2.0',id,result});
        } catch (error) { send({jsonrpc:'2.0',id,error:{code:-32000,message:(error as Error).message}}); }
        finally { if (control && id !== null) calls.delete(id); }
      });
    });
  });
  return {
    checkSessions() { for (const [ws,valid] of clients) if(!valid()) ws.terminate(); },
    close() {
      closing=true;
      for (const ws of clients.keys()) ws.terminate();
      wss.close();
    },
  };
}
