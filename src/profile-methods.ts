import type { FileView } from './file-delegations.ts';
import type { PermissionContext } from './store.ts';
import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';

type Host = EventEmitter & { profileSend:(message:object)=>void };
export type ProfileReader=(actor:string,path:string,workerId?:string,callerView?:FileView,context?:PermissionContext)=>Buffer|Promise<Buffer>;
type Pending = {
  host:Host; actor:string; workerId?:string; callerView?:FileView; context?:PermissionContext;
  resolve:(value:unknown)=>void; reject:(error:Error)=>void; timer:NodeJS.Timeout; cleanup:()=>void;
};

export class ProfileMethods {
  reader?:ProfileReader;
  private starting=new Map<string,{host:Host; waiters:Set<()=>void>}>();
  private methods=new Map<string,Host>();
  private pending=new Map<string,Pending>();

  names() { return [...this.methods.keys()].sort(); }

  attach(name:string,host:Host) {
    const waiters=new Set<()=>void>();
    this.starting.set(name,{host,waiters});
    host.once('profileMethods',payload=>{
      const methods=payload?.methods;
      const valid=Array.isArray(methods) && methods.length<=128 && methods.every(m=>
        typeof m==='string' && /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)*$/.test(m));
      if (valid) for (const method of methods) this.methods.set(name+'.'+method,host);
      this.starting.delete(name);
      for (const dispatch of waiters) dispatch();
      waiters.clear();
    });
    host.on('profileReply',payload=>{
      const {id,result,error}=payload ?? {};
      if (this.pending.get(id)?.host!==host) return;
      this.finish(id,result,error===undefined ? undefined : Error(String(error)));
    });
    host.on('profileRead',payload=>{
      const {id,requestId,path}=payload ?? {};
      const call=this.pending.get(id);
      if (!call || call.host!==host || typeof requestId!=='string' || typeof path!=='string') return;
      const reply=(fields:object)=>{
        if (this.pending.get(id)!==call) return;
        try { host.profileSend({type:'profileFile',id,requestId,...fields}); }
        catch { this.finish(id,undefined,Error('Runner unavailable')); }
      };
      void (async()=>{
        if (!this.reader) throw Error('Caller file view unavailable');
        const bytes=await this.reader(call.actor,path,call.workerId,call.callerView,call.context);
        if (bytes.length>1024*1024) throw Error('Profile input exceeds 1 MiB');
        return bytes.toString('base64');
      })().then(content=>reply({content}),()=>reply({error:'Profile input unavailable or access denied'}));
    });
  }
  detach(host:Host) {
    host.removeAllListeners('profileMethods');
    for (const [name,starting] of this.starting) if (starting.host===host) this.starting.delete(name);
    for (const [key,owner] of this.methods) if (owner===host) this.methods.delete(key);
    for (const [id,call] of this.pending) if (call.host===host) this.finish(id,undefined,Error('Runner unavailable'));
  }
  async call(actor:string,profileId:string,method:string,data:unknown,workerId?:string,signal?:AbortSignal,timeoutMs=30_000,callerView?:FileView,context?:PermissionContext,authorize?:()=>void) {
    if (signal?.aborted) throw Error('Profile operation cancelled');
    if (!Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>86_400_000) throw Error('Invalid timeout');
    const starting=this.starting.get(method.split('.')[0]);
    const host=this.methods.get(method) ?? starting?.host;
    if (!host) throw Error('Profile method unavailable');
    const id=randomUUID();
    return new Promise((resolve,reject)=>{
      const cancel=()=>this.finish(id,undefined,Error('Profile operation cancelled'));
      const dispatch=()=>{
        if (this.methods.get(method)!==host) return this.finish(id,undefined,Error('Profile method unavailable'));
        try { authorize?.(); } catch (error) { return this.finish(id,undefined,error as Error); }
        try { host.profileSend({type:'profileCall',id,caller:actor,profileId,method:method.slice(method.indexOf('.')+1),data}); }
        catch { this.finish(id,undefined,Error('Runner unavailable')); }
      };
      const cleanup=()=>{
        signal?.removeEventListener('abort',cancel);
        starting?.waiters.delete(dispatch);
      };
      const timer=setTimeout(()=>this.finish(id,undefined,Error('Profile operation timed out')),Math.min(timeoutMs,30_000));
      timer.unref();
      this.pending.set(id,{host,actor,workerId,callerView,context,resolve,reject,timer,cleanup});
      signal?.addEventListener('abort',cancel,{once:true});
      if (starting) starting.waiters.add(dispatch); else dispatch();
    });
  }
  private finish(id:string,result?:unknown,issue?:Error) {
    const call=this.pending.get(id);
    if (!call) return;
    clearTimeout(call.timer);
    call.cleanup();
    this.pending.delete(id);
    if (issue) call.reject(issue); else call.resolve(result);
  }
}
