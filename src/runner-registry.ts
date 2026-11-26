import type { FileView } from './file-delegations.ts';
import { EventEmitter } from 'node:events';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { checkedEntrypoint, cliLaunchPlan, installationDirectory, preparedRelease, runnerContract, type ProfileCli, type RunnerMethod } from './runner-installation.ts';
import { withRunnerLock } from '../scripts/runner-storage.mjs';
import { pathToFileURL } from 'node:url';
import { ProcessRunner, type Assignment, type InputRecord } from './runner.ts';
import type { Store } from './store.ts';
import { compilePolicySchema } from './policy-schema.ts';
import { ProfileMethods, type ProfileReader } from './profile-methods.ts';

const operations = ['list','add','disable','enable','restart','delete'];
const registryMethods = operations.map(op=>'$.runners.'+op);
type Entry = {name:string; entrypoint:string|null; enabled:number; managed:number; previousEntrypoint:string|null};

export class RunnerRegistry extends EventEmitter {
  private profiles = new ProfileMethods();
  setProfileReader(reader:ProfileReader) { this.profiles.reader=reader; }
  profileFeatures() { return this.profiles.names(); }
  profileCliFeatures() {
    const features=new Map<string,ProfileCli>();
    const methods=new Set(this.profileFeatures());
    for (const [runner,contract] of this.contracts) {
      if (!this.available(runner)) continue;
      for (const [key,feature] of contract.profileCli) {
        const name=runner+'.'+key;
        if (!methods.has(name)) features.set(name,feature);
      }
    }
    return features;
  }
  async prepareCli(actor:string,node:string,method:string,input:unknown,signal?:AbortSignal) {
    const permitted=()=>this.store.allowsCli(actor,node,method,input);
    if (!permitted()) throw Error('Permission denied');
    const [name,...parts]=method.split('.');
    const key=parts.join('.');
    const host=this.hosts.get(name), feature=this.profileCliFeatures().get(method);
    if (this.store.get(node)?.type!=='profile' || !feature || !host) throw Error('CLI feature unavailable');
    if (!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(k=>k!=='args' && k!=='env') ||
        ('args' in input && (!Array.isArray(input.args) || input.args.some(arg=>typeof arg!=='string' || arg.includes('\0')))) ||
        ('env' in input && (!input.env || typeof input.env!=='object' || Array.isArray(input.env) ||
          Object.entries(input.env).some(([k,v])=>!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v!=='string' || v.includes('\0')))))
      throw Error('Expected CLI arguments and environment');
    if (feature.schema?.input!==undefined && !compilePolicySchema(feature.schema.input)(input))
      throw Error('CLI input does not match schema');
    const reply=await host.adminCall('@cli.prepare',{feature:key,node,input},signal,15_000);
    if (!permitted()) throw Error('Permission denied');
    if (this.closing || this.hosts.get(name)!==host || !this.available(name) || signal?.aborted)
      throw Error('CLI launch cancelled');
    return cliLaunchPlan(this.root,name,reply);
  }
  profileCall(actor:string,profileId:string,method:string,data:unknown,workerId?:string,signal?:AbortSignal,timeoutMs?:number,callerView?:FileView) {
    return this.profiles.call(actor,profileId,method,data,workerId,signal,timeoutMs,callerView);
  }
  private store:Store;
  private hosts=new Map<string,ProcessRunner>();
  readonly initialized:Promise<void>;
  private owners=new Map<string,{host:ProcessRunner; app:string}>();
  private busy=new Set<string>();
  private closing=false;
  private root:string;
  private contracts=new Map<string,ReturnType<typeof runnerContract>>();
  constructor(store:Store,root='/run/pappai/private/runners') {
    super();
    this.root=resolve(root);
    this.store=store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS installed_runners(name TEXT PRIMARY KEY,entrypoint TEXT,enabled INTEGER NOT NULL);
      INSERT OR IGNORE INTO installed_runners VALUES('process',NULL,1);
      CREATE TABLE IF NOT EXISTS runner_settings_schemas(
        name TEXT PRIMARY KEY REFERENCES installed_runners(name) ON DELETE CASCADE, schema TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runner_host_configs(
        name TEXT PRIMARY KEY REFERENCES installed_runners(name) ON DELETE CASCADE, config TEXT NOT NULL)`);
    store.db.exec(`CREATE TABLE IF NOT EXISTS runner_installations(
      name TEXT PRIMARY KEY REFERENCES installed_runners(name) ON DELETE CASCADE, previousEntrypoint TEXT)`);
    this.initialized=Promise.all(this.entries().filter(entry=>entry.enabled).map(async entry=>{
      if (entry.managed) this.busy.add(entry.name);
      try { await this.start(entry); }
      catch(error) {
        await this.stopHost(entry.name);
        if (!this.closing) this.emit('lost',String(error),entry.name);
      } finally { if (entry.managed) this.busy.delete(entry.name); }
    })).then(()=>{});
  }
  private entries() { return this.store.db.prepare(`SELECT r.*, i.previousEntrypoint, i.name IS NOT NULL AS managed
    FROM installed_runners r LEFT JOIN runner_installations i ON i.name=r.name ORDER BY r.name`).all() as Entry[]; }
  has(name:string) { return !!this.store.db.prepare('SELECT 1 FROM installed_runners WHERE name=?').get(name); }
  validateSettings(name:string,settings:unknown) {
    const row=this.store.db.prepare('SELECT schema FROM runner_settings_schemas WHERE name=?').get(name);
    if (row && !compilePolicySchema(JSON.parse(String(row.schema)))(settings))
      throw Error('Settings do not match registered runner schema');
  }
  available(name:string) { return this.hosts.has(name) && !this.busy.has(name); }
  get pid() { return this.hosts.get('process')?.pid; }
  private async start(entry:Entry) {
    const row=this.store.db.prepare('SELECT config FROM runner_host_configs WHERE name=?').get(entry.name);
    const directory=entry.managed ? installationDirectory(this.root,entry.name) : '';
    if (entry.managed) checkedEntrypoint(this.root,entry.name,entry.entrypoint);
    const host=new ProcessRunner(entry.entrypoint ? pathToFileURL(entry.entrypoint) : undefined,String(row?.config ?? '{}'),entry.name,directory);
    this.hosts.set(entry.name,host);
    if (entry.entrypoint) this.profiles.attach(entry.name,host);
    for(const event of ['request','started','written','reply','exit']) host.on(event,msg=>{
      const key=msg?.workerId ?? msg?.id;
      const owner=this.owners.get(key);
      if(!owner || owner.host!==host || owner.app!==msg.appId) return;
      if(event==='exit') this.owners.delete(key);
      this.emit(event,msg);
    });
    host.once('lost',(issue:string)=>{
      if(this.hosts.get(entry.name)!==host) return;
      this.hosts.delete(entry.name);
      this.forget(host);
      this.contracts.delete(entry.name);
      if (!this.busy.has(entry.name)) this.emit('lost',issue,entry.name);
      void this.closeHost(host);
    });
    if (!entry.managed) return;
    await new Promise<void>((accept,reject)=>{
      const finish=(error?:Error)=>{
        clearTimeout(timer);
        host.off('runnerReady',ready);
        host.off('lost',lost);
        host.off('closing',lost);
        if (error) reject(error); else accept();
      };
      const lost=()=>finish(Error('Runner exited before declaring readiness'));
      const ready=(payload:unknown)=>{
        try { this.contracts.set(entry.name,runnerContract(payload)); finish(); }
        catch(error) { finish(error as Error); }
      };
      const timer=setTimeout(()=>finish(Error('Runner readiness timed out')),15_000);
      host.once('runnerReady',ready);
      host.once('lost',lost);
      host.once('closing',lost);
    });
  }
  private forget(host:ProcessRunner) {
    this.profiles.detach(host);
    for (const [key,owner] of this.owners) if(owner.host===host) this.owners.delete(key);
  }
  private async closeHost(host:ProcessRunner) {
    this.profiles.detach(host);
    const timer=setTimeout(()=>{ if(host.pid) try { process.kill(host.pid,'SIGKILL'); } catch {} },15_000);
    try { await host.close(); } finally { clearTimeout(timer); this.forget(host); }
  }
  dispatch(job:Assignment) {
    const name=job.runnerType ?? 'process';
    const host=this.hosts.get(name);
    if(this.closing || !host || this.busy.has(name)) throw Error('Runner unavailable: '+name);
    this.owners.set(job.id,{host,app:job.appId});
    try { host.dispatch(job); } catch(error) { this.owners.delete(job.id); throw error; }
  }
  private host(id:string) {
    const owner=this.owners.get(id);
    if(!owner) throw Error('Executor unavailable');
    return owner.host;
  }
  deliver(id:string,item:InputRecord) { this.host(id).deliver(id,item); }
  notify(id:string,item:object) { this.host(id).notify(id,item); }
  respond(id:string,request:string,data:{result?:unknown;error?:unknown}) { this.host(id).respond(id,request,data); }
  rejectReply(call:string,message:string,id=call) { this.owners.get(id)?.host.rejectReply(call,message,id); }
  stop(id:string) { this.owners.get(id)?.host.stop(id); }

  system(actor:string,target:string,method:string,data:any) {
    if(target!=='~' || !registryMethods.includes(method)) return {handled:false};
    if(!this.store.isAdmin(actor) || !this.store.allows(actor,target,method,data)) throw Error('Permission denied');
    return {handled:true,result:this.operation(method.slice('$.runners.'.length),data)};
  }
  isCodex(name:string) { return this.contracts.has(name) ? this.contracts.get(name)?.kind==='codex' : name==='codex'; }
  workspaceFeatures() {
    const methods=new Map<string,RunnerMethod>();
    for (const [name,contract] of this.contracts) if (!this.busy.has(name))
      for (const [method,feature] of contract.methods) methods.set('runners.'+name+'.'+method,feature);
    return methods;
  }
  async workspaceCall(actor:string,method:string,data:unknown,signal?:AbortSignal,timeoutMs=600_000) {
    if (!this.store.isAdmin(actor) || !this.store.allows(actor,'~',method,data)) throw Error('Permission denied');
    const [,name,...parts]=method.split('.');
    const local=parts.join('.');
    const feature=this.contracts.get(name)?.methods.get(local),host=this.hosts.get(name);
    if (!host || !feature || this.busy.has(name)) throw Error('Runner method unavailable');
    if (!Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>86_400_000) throw Error('Invalid timeout');
    if (feature.schema?.input!==undefined && !compilePolicySchema(feature.schema.input)(data)) throw Error('Input does not match schema');
    const result=await host.adminCall(local,data,signal,timeoutMs);
    if (feature.schema?.output!==undefined && !compilePolicySchema(feature.schema.output)(result)) throw Error('Result does not match schema');
    return result;
  }
  private async stopHost(name:string) {
    const host=this.hosts.get(name);
    this.hosts.delete(name);
    this.contracts.delete(name);
    if (host) await this.closeHost(host);
  }
  private persistSchema(name:string) {
    const schema=this.contracts.get(name)?.settingsSchema;
    if (schema===undefined) this.store.db.prepare('DELETE FROM runner_settings_schemas WHERE name=?').run(name);
    else this.store.db.prepare('INSERT OR REPLACE INTO runner_settings_schemas VALUES(?,?)').run(name,JSON.stringify(schema));
  }
  private async operation(op:string,data:any) {
    const entries=this.entries();
    if(op==='list') return entries.map(entry=>{
      const row=this.store.db.prepare('SELECT schema FROM runner_settings_schemas WHERE name=?').get(entry.name);
      const source=entry.managed && preparedRelease(join(this.root,entry.name),entry.entrypoint)?.source;
      return {name:entry.name,entrypoint:entry.entrypoint,enabled:!!entry.enabled,available:this.available(entry.name),
        previousEntrypoint:entry.previousEntrypoint,...(source && {source}),...(row && {settingsSchema:JSON.parse(String(row.schema))})};
    });
    const {name}=data;
    if(typeof name!=='string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(name)) throw Error('Invalid runner name');
    if(Object.keys(data).some(key=>key!=='name' && !(key==='entrypoint' && ['restart','add'].includes(op))))
      throw Error('Unexpected runner argument');
    if(this.closing || this.busy.has(name)) throw Error('Runner operation in progress');
    const entry=entries.find(e=>e.name===name);
    if(op==='add' && entry) throw Error('Runner already installed');
    if(op!=='add' && !entry) throw Error('Unknown runner');
    if(name==='process' && (op==='delete' || data.entrypoint!==undefined)) throw Error('Built-in runner cannot be removed or replaced');
    this.busy.add(name);
    try {
      const work=()=>this.change(op,name,entry,data.entrypoint);
      if (entry?.managed || op==='add' || data.entrypoint!==undefined) return await withRunnerLock(this.root,name,work);
      return await work();
    } finally { this.busy.delete(name); }
  }
  private async change(op:string,name:string,entry:Entry|undefined,path:unknown) {
    const db=this.store.db;
    const nextPath=op==='add' || path!==undefined ? checkedEntrypoint(this.root,name,path) : undefined;
    if (!entry) {
      const candidate={name,entrypoint:nextPath!,enabled:1,managed:1,previousEntrypoint:null};
      try {
        await this.start(candidate);
        db.exec('SAVEPOINT add_runner');
        try {
          db.prepare('INSERT INTO installed_runners VALUES(?,?,1)').run(name,candidate.entrypoint);
          db.prepare('INSERT INTO runner_installations(name) VALUES(?)').run(name);
          this.persistSchema(name);
          db.exec('RELEASE add_runner');
        } catch(error) { db.exec('ROLLBACK TO add_runner; RELEASE add_runner'); throw error; }
      } catch(error) { await this.stopHost(name); throw error; }
      this.busy.delete(name);
      this.emit('restarted',name);
      return {};
    }
    if (op==='enable' && this.hosts.has(name)) return {};
    if (op==='disable' || op==='delete') {
      this.emit('lost','Runner '+(op==='delete'?'removed':'disabled'),name);
      await this.stopHost(name);
      if (op==='disable') db.prepare('UPDATE installed_runners SET enabled=0 WHERE name=?').run(name);
      else {
        let removed:string|undefined;
        const directory=join(this.root,name);
        if(entry.managed && existsSync(directory)) {
          installationDirectory(this.root,name);
          removed=join(this.root,'.removed-'+randomUUID());
          renameSync(directory,removed);
        }
        try { db.prepare('DELETE FROM installed_runners WHERE name=?').run(name); }
        catch(error) { if (removed) renameSync(removed,directory); throw error; }
        if (removed) rmSync(removed,{recursive:true,force:true});
      }
      return {};
    }
    this.emit('restarting',name);
    await this.stopHost(name);
    const switching=nextPath!==undefined && nextPath!==entry.entrypoint;
    const candidate={...entry,entrypoint:nextPath ?? entry.entrypoint,managed:nextPath===undefined ? entry.managed : 1};
    try {
      await this.start(candidate);
      db.exec('SAVEPOINT select_runner');
      try {
        db.prepare('UPDATE installed_runners SET enabled=1,entrypoint=? WHERE name=?').run(candidate.entrypoint,name);
        if (candidate.managed) {
          if (switching) db.prepare('INSERT OR REPLACE INTO runner_installations(name,previousEntrypoint) VALUES(?,?)').run(name,entry.managed ? entry.entrypoint : null);
          this.persistSchema(name);
        }
        db.exec('RELEASE select_runner');
      } catch(error) {db.exec('ROLLBACK TO select_runner; RELEASE select_runner'); throw error;}
    } catch(error) {
      await this.stopHost(name);
      if (switching && entry.enabled) {
        try { await this.start(entry); }
        catch(rollback) {
          await this.stopHost(name);
          this.emit('lost','Runner rollback failed',name);
          throw Error(String(error)+'; rollback failed: '+String(rollback));
        }
        this.busy.delete(name);
        this.emit('restarted',name);
      } else this.emit('lost',String(error),name);
      throw error;
    }
    this.busy.delete(name);
    this.emit('restarted',name);
    if (switching && entry.previousEntrypoint) {
      const directory=join(this.root,name);
      const old=preparedRelease(directory,entry.previousEntrypoint);
      // Both entrypoints can point into the same prepared release.
      if (old && ![entry.entrypoint,nextPath].some(p=>p?.startsWith(old.release+sep)))
        rmSync(old.release,{recursive:true,force:true});
    }
    return {};
  }
  async close() {
    this.closing=true;
    await Promise.all([...this.hosts.values()].map(host=>this.closeHost(host)));
    this.hosts.clear();
  }
}
