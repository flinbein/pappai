import { EventEmitter } from 'node:events';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ProcessRunner, type Assignment, type InputRecord } from './runner.ts';
import type { Store } from './store.ts';
import { compilePolicySchema } from './policy-schema.ts';

const operations = ['get','add','disable','enable','restart','delete'];
export const registryMethods = operations.map(op=>'$.runners.'+op);
type Entry = {name:string; entrypoint:string|null; enabled:number};

export class RunnerRegistry extends EventEmitter {
  private store:Store;
  private hosts=new Map<string,ProcessRunner>();
  private owners=new Map<string,{host:ProcessRunner; app:string}>();
  private busy=new Set<string>();
  private closing=false;
  constructor(store:Store) {
    super();
    this.store=store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS installed_runners(name TEXT PRIMARY KEY,entrypoint TEXT,enabled INTEGER NOT NULL);
      INSERT OR IGNORE INTO installed_runners VALUES('process',NULL,1);
      CREATE TABLE IF NOT EXISTS runner_settings_schemas(
        name TEXT PRIMARY KEY REFERENCES installed_runners(name) ON DELETE CASCADE, schema TEXT NOT NULL)`);
    for (const entry of this.entries()) if (entry.enabled) this.start(entry);
  }
  private entries() { return this.store.db.prepare('SELECT * FROM installed_runners ORDER BY name').all() as Entry[]; }
  has(name:string) { return !!this.store.db.prepare('SELECT 1 FROM installed_runners WHERE name=?').get(name); }
  validateSettings(name:string,settings:unknown) {
    const row=this.store.db.prepare('SELECT schema FROM runner_settings_schemas WHERE name=?').get(name);
    if (row && !compilePolicySchema(JSON.parse(String(row.schema)))(settings))
      throw Error('Settings do not match registered runner schema');
  }
  available(name:string) { return this.hosts.has(name) && !this.busy.has(name); }
  get pid() { return this.hosts.get('process')?.pid; }
  private start(entry:Entry) {
    const host=new ProcessRunner(entry.entrypoint ? pathToFileURL(entry.entrypoint) : undefined);
    this.hosts.set(entry.name,host);
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
      this.emit('lost',issue,entry.name);
      void this.closeHost(host);
    });
  }
  private forget(host:ProcessRunner) {
    for (const [key,owner] of this.owners) if(owner.host===host) this.owners.delete(key);
  }
  private async closeHost(host:ProcessRunner) {
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
  private async operation(op:string,data:any) {
    const entries=this.entries();
    if(op==='get') return entries.map(entry=>{
      const row=this.store.db.prepare('SELECT schema FROM runner_settings_schemas WHERE name=?').get(entry.name);
      return {...entry,enabled:!!entry.enabled,available:this.available(entry.name),
        ...(row && {settingsSchema:JSON.parse(String(row.schema))})};
    });
    const {name}=data;
    if(typeof name!=='string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(name)) throw Error('Invalid runner name');
    if(this.closing || this.busy.has(name)) throw Error('Runner operation in progress');
    const db=this.store.db;
    let entry=entries.find(e=>e.name===name);
    if(op==='add') {
      if(entry) throw Error('Runner already installed');
      if(typeof data.entrypoint!=='string' || !isAbsolute(data.entrypoint)) throw Error('Expected absolute runner entrypoint');
      const entrypoint=realpathSync(data.entrypoint);
      if(!statSync(entrypoint).isFile()) throw Error('Invalid runner entrypoint');
      if (data.settingsSchema !== undefined) compilePolicySchema(data.settingsSchema);
      entry={name,entrypoint,enabled:1};
      db.exec('SAVEPOINT add_runner');
      try {
        db.prepare('INSERT INTO installed_runners VALUES(?,?,1)').run(name,entrypoint);
        if (data.settingsSchema !== undefined) db.prepare('INSERT INTO runner_settings_schemas VALUES(?,?)')
          .run(name,JSON.stringify(data.settingsSchema));
        this.start(entry);
        db.exec('RELEASE add_runner');
      } catch (error) {
        db.exec('ROLLBACK TO add_runner; RELEASE add_runner');
        throw error;
      }
      return {};
    }
    if(!entry) throw Error('Unknown runner');
    if(op==='delete' && name==='process') throw Error('Built-in runner can be disabled');
    this.busy.add(name);
    try {
      const host=this.hosts.get(name);
      if(op==='enable' && host) return {};
      if(op==='restart' || op==='enable') this.emit('restarting',name);
      else this.emit('lost','Runner '+(op==='delete'?'removed':'disabled'),name);
      if(host) {
        this.hosts.delete(name);
        await this.closeHost(host);
      }
      if(op==='delete') db.prepare('DELETE FROM installed_runners WHERE name=?').run(name);
      else {
        const enabled=Number(op!=='disable');
        db.prepare('UPDATE installed_runners SET enabled=? WHERE name=?').run(enabled,name);
        if(enabled && !this.closing) {
          this.start(entry);
          this.busy.delete(name);
          this.emit('restarted',name);
        }
      }
      return {};
    } finally { this.busy.delete(name); }
  }
  async close() {
    this.closing=true;
    await Promise.all([...this.hosts.values()].map(host=>this.closeHost(host)));
    this.hosts.clear();
  }
}
