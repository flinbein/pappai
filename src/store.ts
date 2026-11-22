import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { allowsAtLevel, filesystemProfile, fileLevel, networkAllowed, selectsNode, validNodes, validateSchemaSelector, validatePermissions } from './permits.ts';
import type { Capability, NodeType, Permissions, Rule } from './permits.ts';

export type NodeStatus = 'stopped' | 'working' | 'stopping' | 'error';
export type NodeRecord = {
  id: string;
  parentId: string | null;
  type: NodeType;
  name: string;
  status: NodeStatus;
  email: string | null;
  permissions: Permissions;
  manifest: unknown;
  profile?: string | null;
  scope?: Rule['node'];
  httpName?: string | null;
  lastIssue: string | null;
};

type NodeSettings = {name: string; email?: string; permissions?: unknown; manifest?: unknown; profile?: unknown; scope?: unknown};
type SqlNode = Omit<NodeRecord,'permissions'|'manifest'|'scope'> & {permissions: string; manifest: string | null; scope?: string | null};
export type DirectoryEntry = Pick<NodeRecord,'id'|'parentId'|'type'|'name'> & {status?: NodeStatus};
type PolicyNode = Pick<NodeRecord,'id'|'parentId'|'type'|'name'|'status'|'permissions'>;

function decode(row: SqlNode): NodeRecord {
  const {scope,...fields}=row;
  return {...fields,...(scope && {scope:JSON.parse(scope)}), permissions: JSON.parse(row.permissions), manifest: row.manifest ? JSON.parse(row.manifest) : null};
}

function emailKey(input: unknown) {
  if (typeof input !== 'string') throw new Error('Email required');
  const email = input.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error('Invalid email');
  return email;
}

function lineage<T extends PolicyNode>(node: T, get: (id: string) => T | undefined) {
  const result = [node];
  while (node.parentId !== null) {
    const parent = get(node.parentId);
    if (!parent) throw new Error('Incomplete workspace hierarchy');
    result.push(parent);
    node = parent;
  }
  return result;
}

function activeCaller(node: PolicyNode | undefined): node is PolicyNode {
  return !!node && (node.type === 'user' || node.type === 'app') && node.status === 'working';
}

export class Store {
  readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    // SQLite requires foreign keys off while replacing a referenced table.
    db.exec('PRAGMA foreign_keys=OFF; PRAGMA busy_timeout=5000;');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('CREATE TABLE IF NOT EXISTS store_migrations(version INTEGER PRIMARY KEY)');
      const version=Number(db.prepare('SELECT MAX(version) AS version FROM store_migrations').get()?.version ?? 0);
      if (![0,1,2].includes(version)) throw Error('Unsupported workspace database version');
      if (version < 2) {
        db.exec(`CREATE TABLE nodes_v2 (
          id TEXT PRIMARY KEY, parentId TEXT REFERENCES nodes(id), type TEXT NOT NULL,
          name TEXT NOT NULL, status TEXT NOT NULL, email TEXT UNIQUE, permissions TEXT NOT NULL,
          manifest TEXT, lastIssue TEXT, profile TEXT, scope TEXT,
          CHECK(type IN ('workspace','team','user','app','profile')),
          CHECK(status IN ('working','stopped','stopping','error')),
          CHECK((type='workspace') = (id='~')),
          CHECK((type='workspace') = (parentId IS NULL)),
          CHECK((type='user') = (email IS NOT NULL)),
          CHECK(type!='workspace' OR permissions='null')
        ) STRICT;`);
        if (version===1) {
          db.exec(`INSERT INTO nodes_v2(id,parentId,type,name,status,email,permissions,manifest,lastIssue)
            SELECT id,parentId,type,name,status,email,permissions,manifest,lastIssue FROM nodes;
            DROP TABLE nodes;`);
        }
        db.exec('ALTER TABLE nodes_v2 RENAME TO nodes; INSERT INTO store_migrations VALUES(2)');
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS team_members(
          team TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
          member TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, PRIMARY KEY(team,member)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS memberships_by_member ON team_members(member);
        CREATE TABLE IF NOT EXISTS personal_subscriptions(
          node TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE, rules TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS http_names(
          node TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE, name TEXT UNIQUE NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS nodes_parent ON nodes(parentId);
        INSERT INTO nodes(id,type,name,status,permissions) VALUES('~','workspace','workspace','working','null')
          ON CONFLICT(id) DO NOTHING;
        INSERT OR IGNORE INTO store_migrations VALUES (1);
      `);
      if (version < 2 && db.prepare('PRAGMA foreign_key_check').get()) throw Error('Workspace foreign key violation');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally { db.exec('PRAGMA foreign_keys=ON'); }
  }

  get(id: string): NodeRecord | undefined {
    const row = this.db.prepare('SELECT n.*, h.name AS httpName FROM nodes n LEFT JOIN http_names h ON n.id=h.node WHERE n.id=?').get(id);
    return row ? decode(row as SqlNode) : undefined;
  }

  byEmail(email: string): NodeRecord | undefined {
    const row = this.db.prepare('SELECT * FROM nodes WHERE email=?').get(emailKey(email));
    return row ? decode(row as SqlNode) : undefined;
  }

  create(parentId: string, type: Exclude<NodeType,'workspace'>, settings: NodeSettings): NodeRecord {
    if (!['team','user','app','profile'].includes(type)) throw new Error('Unsupported node type');
    const parent = this.get(parentId);
    if (!parent || !['workspace','team'].includes(parent.type)) throw new Error('Invalid parent');
    if (typeof settings?.name !== 'string' || !settings.name.trim() || settings.name.length > 255) {
      throw new Error('Name required (up to 255 characters)');
    }
    const permissions = settings.permissions === undefined ? [] : settings.permissions;
    validatePermissions(permissions);
    const email = type === 'user' ? emailKey(settings.email) : null;
    if (type !== 'user' && settings.email !== undefined) throw new Error('Only users have an email');
    if (type === 'app') {
      if (!settings.manifest || typeof settings.manifest !== 'object' || Array.isArray(settings.manifest)) {
        throw new Error('APP needs an inline manifest');
      }
    } else if (settings.manifest !== undefined) throw new Error('Only APPs have manifests');
    const profile = settings.profile ?? null;
    if (profile !== null && (type !== 'app' || typeof profile !== 'string' || this.get(profile)?.type !== 'profile'))
      throw Error('Invalid APP profile');
    const scope = settings.scope === undefined ? [] : settings.scope;
    if ((type !== 'profile' && settings.scope !== undefined) || !Array.isArray(scope) || !validNodes(scope))
      throw Error('Invalid profile scope');
    const row = this.db.prepare(`
      INSERT INTO nodes(id,parentId,type,name,status,email,permissions,manifest,profile,scope)
      VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING *
    `).get(randomUUID(), parentId, type, settings.name, type === 'team' ? 'working' : 'stopped',
      email, JSON.stringify(permissions), type === 'app' ? JSON.stringify(settings.manifest) : null, profile, type==='profile' ? JSON.stringify(scope) : null);
    return decode(row as SqlNode);
  }

  /** Used by the trusted local account-recovery command, in its credential-reset transaction. */
  ensureAdmin(input: string): NodeRecord {
    const email = emailKey(input);
    const row = this.db.prepare(`
      INSERT INTO nodes(id,parentId,type,name,status,email,permissions) VALUES(?,'~','user',?,'working',?,'null')
      ON CONFLICT(email) DO UPDATE SET parentId='~',permissions='null',status='working',lastIssue=NULL
      RETURNING *
    `).get(randomUUID(), email, email);
    return decode(row as SqlNode);
  }

  setStatus(id: string, status: NodeStatus, issue?: string): NodeRecord {
    const row = this.db.prepare(`
      UPDATE nodes SET status=?,lastIssue=COALESCE(?, lastIssue) WHERE id=? AND type IN ('user','app') RETURNING *
    `).get(status, issue ?? null, id);
    if (!row) throw new Error('No such APP or USER');
    return decode(row as SqlNode);
  }

  setManifest(id: string, manifest: unknown) {
    const result = this.db.prepare("UPDATE nodes SET manifest=? WHERE id=? AND type='app'").run(JSON.stringify(manifest), id);
    if (!result.changes) throw Error('Unknown APP');
  }

  recoverInterruptedStops() {
    this.db.prepare("UPDATE nodes SET status='error', lastIssue=? WHERE type='app' AND status='stopping'")
      .run('Controller restarted before executor exit was confirmed');
  }

  eventRecipients(): NodeRecord[] {
    return this.db.prepare("SELECT * FROM nodes WHERE type IN ('app','user') ORDER BY rowid").all().map(row=>decode(row as SqlNode));
  }

  workingApps(): NodeRecord[] {
    return this.db.prepare("SELECT * FROM nodes WHERE type='app' AND status='working'").all().map(row => decode(row as SqlNode));
  }

  private chain(node: NodeRecord) {
    return lineage(node, id => this.get(id));
  }

  private paths(actor: NodeRecord) {
    const teams = this.db.prepare('SELECT team FROM team_members WHERE member=?').all(actor.id);
    return [this.chain(actor), ...teams.map(row => [actor, ...this.chain(this.get(String(row.team))!)])];
  }

  private member = (team: string, id: string) => !!this.db.prepare(
    'SELECT 1 FROM team_members WHERE team=? AND member=?').get(team,id);

  selects(ownerId: string, targetId: string, selector: Rule['node'] = true, types?: Rule['nodeType'], caller = ownerId) {
    const owner = this.get(ownerId), target = this.get(targetId);
    if (!owner || !target || !validNodes(selector)) return false;
    return selectsNode({node:selector,nodeType:types},this.chain(owner).map(n=>n.id),
      this.chain(target).map(n=>n.id),target.type,caller,this.member);
  }

  resolveNodes(owner: string, selector: Rule['node'], types?: Rule['nodeType']) {
    validateSchemaSelector(selector,types);
    return this.db.prepare('SELECT id FROM nodes ORDER BY id').all().map(r=>String(r.id))
      .filter(id=>this.selects(owner,id,selector,types));
  }

  profileFor(app: NodeRecord) {
    if (!app.profile) return undefined;
    const profile = this.get(app.profile);
    if (profile?.type !== 'profile' || profile.status !== 'working' ||
        !this.selects(profile.id,app.id,profile.scope ?? [],'app')) throw Error('Profile does not permit this APP');
    return profile;
  }

  isAdmin(actorId: string): boolean {
    const actor = this.get(actorId);
    if (!activeCaller(actor)) return false;
    try {
      this.profileFor(actor);
      return this.paths(actor).some(chain=>chain.every(n=>n.permissions===null));
    } catch { return false; }
  }

  private filePolicies(node: NodeRecord, actor = node) {
    const ids = this.chain(actor).map(n=>n.id);
    return this.paths(node).map(chain=>chain.map(owner=>owner.permissions?.filter(rule=>
      selectsNode(rule,this.chain(owner).map(n=>n.id),ids,actor.type,actor.id,this.member)) ?? null));
  }

  profileMcpNetwork(app:NodeRecord, appNetwork:boolean) {
    const profile=this.profileFor(app);
    return !!profile && appNetwork && networkAllowed(this.filePolicies(profile,app));
  }

  private principalFilePolicies(id:string) {
    const node=this.get(id);
    if (!node || (node.type !== 'app' && node.type !== 'user')) throw Error('Unknown filesystem principal');
    this.profileFor(node);
    return this.filePolicies(node);
  }
  sandbox(nodeId: string) {
    return filesystemProfile(this.principalFilePolicies(nodeId));
  }

  allowsFile(actorId: string, path: string, write = false) {
    return this.fileSnapshot(actorId).allows(path,write);
  }

  fileSnapshot(actorId:string) {
    const policies=this.principalFilePolicies(actorId);
    const sandbox=filesystemProfile(policies);
    const allows=(path:string,write=false) => {
      if (!path.startsWith('/') || path.includes('\0') || path.split('/').some(p=>p==='.' || p==='..')) return false;
      if (path==='/tmp' || path.startsWith('/tmp/')) return true;
      if (!sandbox) return true;
      if (['/proc','/dev','/sys','/run'].some(p=>path===p || path.startsWith(p+'/'))) return false;
      return policies.some(chain=>chain.every(rules=>fileLevel(rules,path)>=(write?2:1)));
    };
    return {sandbox,allows};
  }

  private permitted(actorId: string,targetId: string,capability: Capability,method?:string,data?:unknown,recovery = false, live = false) {
    const actor = this.get(actorId), target = this.get(targetId);
    if (!actor || (!(live && actor.type==='app') && !(recovery && actor.type==='user' && actorId===targetId) && !activeCaller(actor)) || !target) return false;
    const targets = this.chain(target).map(n=>n.id);
    try {
      this.profileFor(actor);
      return this.paths(actor).some(chain=>chain.every(owner=>allowsAtLevel(owner.permissions,
        this.chain(owner).map(n=>n.id),targets,target.type,actorId,method,capability,data,
        (selector,types)=>this.resolveNodes(owner.id,selector,types),this.member)));
    } catch { return false; }
  }
  allowsLiveExecutor(actor:string,target:string,method:string,data?:unknown) {
    return this.permitted(actor,target,'methods',method,data,false,true);
  }

  allowsRecovery(actor:string,target:string,method:string) { return this.permitted(actor,target,'methods',method,{},true); }

  allows(actor: string,target: string,method: string,data?:unknown) {
    return typeof method === 'string' && !!method && this.permitted(actor,target,'methods',method,data);
  }
  allowsEvent(receiver:string,source:string,event:string,data?:unknown) {
    return this.permitted(receiver,source,'events',event,data);
  }
  allowsDelivery(actor:string,target:string) { return actor===target || this.permitted(actor,target,'delivery'); }
  hasHttp(id:string) { return this.permitted(id,id,'http'); }
  canDiscover(actor:string,target:string) { return this.permitted(actor,target,'discover'); }

  getSubscriptions(id:string): any[] {
    const row=this.db.prepare('SELECT rules FROM personal_subscriptions WHERE node=?').get(id);
    return row ? JSON.parse(String(row.rules)) : [];
  }
  setSubscriptions(id:string,rules:any[]) {
    this.db.prepare('INSERT OR REPLACE INTO personal_subscriptions(node,rules) VALUES(?,?)').run(id,JSON.stringify(rules));
  }
  getByHttpName(name:string) {
    const row=this.db.prepare('SELECT node FROM http_names WHERE name=?').get(name);
    return row ? this.get(String(row.node)) : undefined;
  }
  setHttpName(id:string,name:unknown) {
    if (this.get(id)?.type!=='app') throw Error('Expected an APP');
    if (name===null) { this.db.prepare('DELETE FROM http_names WHERE node=?').run(id); return; }
    if (typeof name!=='string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) throw Error('Invalid HTTP name');
    this.db.prepare('INSERT INTO http_names VALUES(?,?) ON CONFLICT(node) DO UPDATE SET name=excluded.name').run(id,name);
  }
  managementNames(type:NodeType) {
    const names=type==='workspace'?[]:['$.node.permissions.get','$.node.permissions.set'];
    if(type==='team') names.push(...['list','add','delete'].map(op=>'$.team.members.'+op));
    if(type==='app'||type==='user'||type==='profile') names.push(...['list','add','delete'].map(op=>'$.app.memberships.'+op));
    if(type==='app') names.push('$.app.http.get','$.app.http.set','$.app.profile.set');
    if(type==='profile') names.push('$.profile.get','$.profile.scope.set','$.profile.enable','$.profile.disable');
    return names;
  }
  manage(actorId:string,id:string,method:string,data:any): {handled:boolean;result?:any} {
    const node=this.get(id);
    if(!node || !this.managementNames(node.type).includes(method)) return {handled:false};
    if(!this.allows(actorId,id,method,data)) throw Error('Permission denied');
    let result:any={};
    if (method==='$.profile.get') result={scope:node.scope,status:node.status};
    else if(method==='$.profile.scope.set') {
      if (!Array.isArray(data.scope) || !validNodes(data.scope)) throw Error('Invalid profile scope');
      this.db.prepare('UPDATE nodes SET scope=? WHERE id=?').run(JSON.stringify(data.scope),id);
    } else if(method==='$.profile.enable' || method==='$.profile.disable') {
      this.db.prepare('UPDATE nodes SET status=? WHERE id=?').run(method.endsWith('enable')?'working':'stopped',id);
    } else if(method==='$.app.profile.set') {
      if (data.profile!==null && (typeof data.profile!=='string' || this.get(data.profile)?.type!=='profile'))
        throw Error('Invalid APP profile');
      this.db.prepare('UPDATE nodes SET profile=? WHERE id=?').run(data.profile,id);
    } else if (method==='$.node.permissions.get') result={permissions:node.permissions};
    else if(method==='$.node.permissions.set') {
      validatePermissions(data.permissions);
      this.db.prepare('UPDATE nodes SET permissions=? WHERE id=?').run(JSON.stringify(data.permissions),id);
    } else if(method==='$.app.http.get') result={name:node.httpName};
    else if(method==='$.app.http.set') this.setHttpName(id,data.name);
    else {
      const onTeam=node.type==='team';
      if(method.endsWith('.list')) {
        result=this.db.prepare(onTeam?'SELECT member AS id FROM team_members WHERE team=? ORDER BY member':
          'SELECT team AS id FROM team_members WHERE member=? ORDER BY team').all(id).map(r=>r.id);
      } else {
        const team=onTeam?id:data.teamId, member=onTeam?data.appId:id;
        if(typeof team!=='string'||typeof member!=='string'||this.get(team)?.type!=='team'||
          !['app','user','profile'].includes(this.get(member)?.type??'')) throw Error('Expected TEAM and APP or USER');
        if(method.endsWith('.add')) this.db.prepare('INSERT OR IGNORE INTO team_members VALUES(?,?)').run(team,member);
        else this.db.prepare('DELETE FROM team_members WHERE team=? AND member=?').run(team,member);
      }
    }
    return {handled:true,result};
  }

  visible(actorId: string): DirectoryEntry[] {
    const actor=this.get(actorId);
    if(!activeCaller(actor)) return [];
    if (actor.profile) { try { this.profileFor(actor); } catch { return []; } }
    const index=new Map<string,PolicyNode>();
    for(const row of this.db.prepare('SELECT id,parentId,type,name,status,permissions FROM nodes ORDER BY rowid').all()){
      const n=row as Omit<PolicyNode,'permissions'> & {permissions:string};
      index.set(n.id,{...n,permissions:JSON.parse(n.permissions)});
    }
    const lookup=(id:string)=>index.get(id);
    const owners=this.paths(actor).map(chain=>chain.map(owner=>({rules:owner.permissions,ids:lineage(owner,lookup).map(n=>n.id)})));
    const entries=new Map<string,DirectoryEntry>();
    for(const node of index.values()) {
      const chain=lineage(node,lookup), ids=chain.map(n=>n.id);
      if(!owners.some(path=>path.every(o=>allowsAtLevel(o.rules,o.ids,ids,node.type,actorId,undefined,'discover',undefined,undefined,this.member)))) continue;
      for(const n of chain.reverse()) if(!entries.has(n.id)) {
        const {id,parentId,type,name,status}=n;
        entries.set(id,{id,parentId,type,name,...(['app','user'].includes(type)?{status}:{})});
      }
    }
    return [...entries.values()];
  }
}
