import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { allowsAtLevel, filesystemProfile, fileLevel, mountedPermissions, networkAllowed, selectsNode, validNodes, validateSchemaSelector, validatePermissions } from './permits.ts';
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
type PermissionLayer = {readonly subjects: readonly string[]; readonly permissions?: Rule[]};
export type PermissionContext = readonly PermissionLayer[];

export function normalizeCreateTeamData(data: NodeSettings) {
  if (data.permissions !== undefined) return data;
  return {...data, permissions: [
    {node:'./**', methods:true, cli:true, events:true, delivery:true, discover:true},
    {node:'.', methods:['$.children.createTeam','$.children.createUser','$.children.createApp','$.children.createProfile']},
  ]};
}

export function normalizeCallData(method:string,data:any,targetType?:NodeType) {
  if (method==='$.children.createTeam' && data && typeof data==='object' && !Array.isArray(data))
    return normalizeCreateTeamData(data);
  if (targetType==='profile' && !method.startsWith('$.') || targetType==='workspace' && method.startsWith('runners.'))
    return data ?? {};
  return method.startsWith('$.') && data===undefined ? {} : data;
}

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

function activeCaller<T extends PolicyNode>(node: T | undefined): node is T {
  return !!node && ['user','app','team','workspace'].includes(node.type) && node.status === 'working';
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
    const {permissions = []} = type === 'team' ? normalizeCreateTeamData(settings) : settings;
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
      UPDATE nodes SET status=?,lastIssue=COALESCE(?, lastIssue) WHERE id=? AND type IN ('user','app','profile') RETURNING *
    `).get(status, issue ?? null, id);
    if (!row) throw new Error('No such APP, USER or PROFILE');
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

  permissionSubjects(ownerId?: string): string[] {
    const subjects = "SELECT id FROM nodes WHERE type IN ('app','user','profile')";
    // A membership change can also alter target selectors inside unrelated principals' rules.
    if (ownerId === undefined) return this.db.prepare(subjects).all().map(row=>String(row.id));
    const rows = this.db.prepare(`
      WITH RECURSIVE branch(id) AS (
        SELECT id FROM nodes WHERE id=?
        UNION ALL SELECT child.id FROM nodes child JOIN branch ON child.parentId=branch.id
      )
      ${subjects} AND (
        id IN (SELECT id FROM branch) OR
        id IN (SELECT member FROM team_members WHERE team IN (SELECT id FROM branch))
      )
    `).all(ownerId);
    return rows.map(row=>String(row.id));
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
    return this.principalAdmin(actor);
  }

  private principalAdmin(actor: NodeRecord) {
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
    if (!node || node.type === 'profile') throw Error('Unknown filesystem principal');
    this.profileFor(node);
    return this.filePolicies(node);
  }
  sandbox(nodeId: string) {
    return filesystemProfile(this.principalFilePolicies(nodeId));
  }

  allowsFile(actorId: string, path: string, write = false) {
    return this.fileSnapshot(actorId).allows(path,write);
  }

  fileSnapshot(actorId:string, ctx?:PermissionContext, ceiling?:ReturnType<typeof filesystemProfile>) {
    this.validateContext(actorId,ctx);
    return this.subjectFileSnapshot(actorId,actorId,ctx,ceiling);
  }

  private subjectFileSnapshot(actorId:string, subjectId:string, ctx?:PermissionContext, ceiling?:ReturnType<typeof filesystemProfile>) {
    const subjects=[this.principalFilePolicies(subjectId)];
    for (const layer of ctx ?? []) {
      for (const id of layer.subjects) subjects.push(this.principalFilePolicies(id));
      if (layer.permissions) {
        const owner=this.get(actorId)!;
        const ids=this.chain(owner).map(n=>n.id);
        subjects.push([[layer.permissions.filter(rule=>selectsNode(rule,ids,ids,owner.type,actorId,this.member))]]);
      }
    }
    if (ceiling) subjects.push([[mountedPermissions(ceiling)]]);
    const sandbox=filesystemProfile(...subjects);
    const allows=(path:string,write=false) => {
      if (typeof path !== 'string' || !path.startsWith('/') || path.includes('//') || path.includes('\0') || path.split('/').some(p=>p==='.' || p==='..')) return false;
      if (path==='/tmp' || path.startsWith('/tmp/')) return true;
      if (!sandbox) return true;
      if (['/proc','/dev','/sys','/run'].some(p=>path===p || path.startsWith(p+'/'))) return false;
      return subjects.every(policies=>policies.some(chain=>chain.every(rules=>fileLevel(rules,path)>=(write?2:1))));
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
  allowsCli(actor:string,target:string,feature:string,input:unknown) {
    return this.permitted(actor,target,'cli',feature,input);
  }
  allowsEvent(receiver:string,source:string,event:string,data?:unknown) {
    return this.permitted(receiver,source,'events',event,data);
  }
  allowsDelivery(actor:string,target:string) { return actor===target || this.permitted(actor,target,'delivery'); }
  hasHttp(id:string) { return this.permitted(id,id,'http'); }
  canDiscover(actor:string,target:string) { return this.permitted(actor,target,'discover'); }

  private restrictionSubject(id:string) {
    const node=this.get(id);
    if (!activeCaller(node) || node.type==='workspace') throw Error('Permission denied');
    try { this.profileFor(node); } catch { throw Error('Permission denied'); }
    return node;
  }

  private layerAllows(actor:string, layer:PermissionLayer, target:string, capability:Capability, method?:string, data?:unknown) {
    if (!layer.subjects.every(id=>this.principalAllows(id,target,capability,method,data))) return false;
    if (!layer.permissions) return true;
    const owner=this.get(actor), node=this.get(target);
    return !!owner && !!node && allowsAtLevel(layer.permissions,this.chain(owner).map(n=>n.id),
      this.chain(node).map(n=>n.id),node.type,actor,method,capability,data,
      (selector,types)=>this.resolveNodes(actor,selector,types),this.member);
  }

  private principalAllows(id:string,target:string,capability:Capability,method?:string,data?:unknown) {
    if (id===target && (capability==='checkPermissions' || capability==='delivery')) return activeCaller(this.get(id));
    return this.permitted(id,target,capability,method,data);
  }

  private authorizeSubject(actor:string, inherited:PermissionContext, id:string) {
    if (id!==actor && (!this.principalAllows(actor,id,'checkPermissions') ||
        !inherited.every(layer=>this.layerAllows(actor,layer,id,'checkPermissions')))) throw Error('Permission denied');
    this.restrictionSubject(id);
  }

  validateContext(actor:string, ctx:PermissionContext|undefined) {
    if (!ctx) return;
    const caller=this.get(actor);
    if (!activeCaller(caller)) throw Error('Permission denied');
    try { this.profileFor(caller); } catch { throw Error('Permission denied'); }
    // Grants within a single request are acquired together. Later requests must
    // also pass every earlier bound, including after membership or rule changes.
    const inherited:PermissionLayer[]=[];
    for (const layer of ctx) {
      for (const id of layer.subjects) this.authorizeSubject(actor,inherited,id);
      inherited.push(layer);
    }
  }

  restrict(actor:string, inherited:PermissionContext|undefined, restrictPermissions?:unknown, permissions?:unknown):PermissionContext|undefined {
    if (restrictPermissions!==undefined && (!Array.isArray(restrictPermissions) ||
        !restrictPermissions.every(id=>typeof id==='string'))) throw Error('Expected restrictPermissions to be an array of node IDs');
    const subjects=[...new Set((restrictPermissions ?? []) as string[])];
    if (!subjects.length && permissions==null) {
      this.validateContext(actor,inherited);
      return inherited;
    }
    const layer: {subjects:string[];permissions?:Rule[]}={subjects};
    const ctx=[...(inherited ?? []),layer];
    this.validateContext(actor,ctx);
    if (permissions!=null) {
      // Transient rules only narrow access. Checking the controller filesystem
      // here would allow an ordinary caller to probe paths outside their view.
      validatePermissions(permissions,false);
      layer.permissions=structuredClone(permissions);
    }
    return ctx;
  }

  private subjectsAdmin(subject:string,ctx?:PermissionContext) {
    const principal=this.get(subject);
    return activeCaller(principal) && this.principalAdmin(principal) &&
      (ctx ?? []).every(layer=>!layer.permissions && layer.subjects.every(id=>this.principalAdmin(this.get(id)!)));
  }

  contextAdmin(actor:string,ctx?:PermissionContext) {
    this.validateContext(actor,ctx);
    return this.subjectsAdmin(actor,ctx);
  }

  private subjectAllows(actor:string,subject:string,ctx:PermissionContext|undefined,target:string,capability:Capability,method?:string,data?:unknown) {
    if (capability==='methods' && target==='~' && (method?.startsWith('$.runners.') || method?.startsWith('runners.')) &&
        !this.subjectsAdmin(subject,ctx)) return false;
    return this.principalAllows(subject,target,capability,method,data) &&
      (ctx ?? []).every(layer=>this.layerAllows(actor,layer,target,capability,method,data));
  }

  contextAllows(actor:string,ctx:PermissionContext|undefined,target:string,capability:Capability,method?:string,data?:unknown) {
    this.validateContext(actor,ctx);
    return this.subjectAllows(actor,actor,ctx,target,capability,method,data);
  }

  checkPermissions(actor:string,params:any,ctx?:PermissionContext,ceiling?:ReturnType<typeof filesystemProfile>) {
    this.validateContext(actor,ctx);
    const caller=this.get(actor);
    if (!activeCaller(caller)) throw Error('Permission denied');
    try { this.profileFor(caller); } catch { throw Error('Permission denied'); }
    const subject=params?.subject===undefined ? actor : params.subject;
    if (typeof subject!=='string') throw Error('Permission denied');
    if (subject!==actor) this.authorizeSubject(actor,ctx ?? [],subject);
    const action=params?.action;
    if (!action || typeof action!=='object' || Array.isArray(action)) throw Error('Expected a permission action');
    const {type,node}=action;
    if (['network','read','write'].includes(type)) {
      const view=this.subjectFileSnapshot(actor,subject,ctx,actor===subject ? ceiling : undefined);
      if (type==='network') return {allowed:view.sandbox?.network ?? true};
      if (typeof action.path!=='string' || !action.path.startsWith('/')) throw Error('Expected an absolute path');
      return {allowed:view.allows(action.path,type==='write')};
    }
    if (type==='http') return {allowed:this.subjectAllows(actor,subject,ctx,subject,'http')};
    if (typeof node!=='string' || !node) throw Error('Expected an action node');
    switch (type) {
      case 'call': {
        if (typeof action.method!=='string' || !action.method) throw Error('Expected an action method');
        const data=normalizeCallData(action.method,action.data,this.get(node)?.type);
        return {allowed:this.subjectAllows(actor,subject,ctx,node,'methods',action.method,data)};
      }
      case 'cli':
        if (typeof action.method!=='string' || !action.method) throw Error('Expected a CLI method');
        return {allowed:this.subjectAllows(actor,subject,ctx,node,'cli',action.method,action.input===undefined ? {} : action.input)};
      case 'event':
        if (typeof action.event!=='string' || !action.event) throw Error('Expected an event name');
        return {allowed:this.subjectAllows(actor,subject,ctx,node,'events',action.event,action.data)};
      case 'help': case 'discover': return {allowed:this.subjectAllows(actor,subject,ctx,node,'discover')};
      case 'delivery': return {allowed:this.subjectAllows(actor,subject,ctx,node,'delivery')};
      case 'checkPermissions': {
        if (node===subject) return {allowed:true};
        if (!this.subjectAllows(actor,subject,ctx,node,'checkPermissions')) return {allowed:false};
        try { this.restrictionSubject(node); } catch { return {allowed:false}; }
        return {allowed:true};
      }
      default: throw Error('Unknown permission action');
    }
  }

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
    const names=type==='workspace'?[]:['$.node.get','$.permissions.get','$.permissions.set'];
    if(type==='team') names.push('$.team.members.list','$.team.members.add','$.team.members.remove');
    if(type==='app'||type==='user'||type==='profile') names.push('$.memberships.list');
    if(type==='app') names.push('$.app.http.get','$.app.http.set','$.app.profile.set');
    if(type==='profile') names.push('$.profile.scope.get','$.profile.scope.set');
    return names;
  }
  manage(actorId:string,id:string,method:string,data:any,ctx?:PermissionContext): {handled:boolean;result?:any;changed?:boolean} {
    const node=this.get(id);
    if(!node || !this.managementNames(node.type).includes(method)) return {handled:false};
    if(!this.contextAllows(actorId,ctx,id,'methods',method,data)) throw Error('Permission denied');
    let result:any={};
    let changed:boolean|undefined;
    if (method==='$.node.get') result={id,parentId:node.parentId,type:node.type,name:node.name,status:node.status};
    else if (method==='$.profile.scope.get') result={scope:node.scope};
    else if(method==='$.profile.scope.set') {
      if (!Array.isArray(data.scope) || !validNodes(data.scope)) throw Error('Invalid profile scope');
      this.db.prepare('UPDATE nodes SET scope=? WHERE id=?').run(JSON.stringify(data.scope),id);
    } else if(method==='$.app.profile.set') {
      if (data.profile!==null && (typeof data.profile!=='string' || this.get(data.profile)?.type!=='profile'))
        throw Error('Invalid APP profile');
      this.db.prepare('UPDATE nodes SET profile=? WHERE id=?').run(data.profile,id);
    } else if (method==='$.permissions.get') result={permissions:node.permissions};
    else if(method==='$.permissions.set') {
      validatePermissions(data.permissions);
      changed=!isDeepStrictEqual(data.permissions,node.permissions);
      if (changed) this.db.prepare('UPDATE nodes SET permissions=? WHERE id=?').run(JSON.stringify(data.permissions),id);
    } else if(method==='$.app.http.get') result={name:node.httpName};
    else if(method==='$.app.http.set') this.setHttpName(id,data.name);
    else if(method==='$.team.members.list' || method==='$.memberships.list') {
      result=this.db.prepare(node.type==='team'?'SELECT member AS id FROM team_members WHERE team=? ORDER BY member':
        'SELECT team AS id FROM team_members WHERE member=? ORDER BY team').all(id).map(r=>r.id);
    } else if(method==='$.team.members.add' || method==='$.team.members.remove') {
      const member=data.memberId;
      if(typeof member!=='string' || !['app','user','profile'].includes(this.get(member)?.type??'')) {
        throw Error('Expected an APP, USER or PROFILE memberId');
      }
      const query=method==='$.team.members.add'?'INSERT INTO team_members(team,member) VALUES(?,?) ON CONFLICT DO NOTHING':
        'DELETE FROM team_members WHERE team=? AND member=?';
      changed=!!this.db.prepare(query).run(id,member).changes;
    }
    return {handled:true,result,...(changed!==undefined && {changed})};
  }

  visible(actorId: string, ctx?:PermissionContext): DirectoryEntry[] {
    this.validateContext(actorId,ctx);
    const actor=this.get(actorId);
    if(!activeCaller(actor)) return [];
    if (actor.profile) { try { this.profileFor(actor); } catch { return []; } }
    const index=new Map<string,PolicyNode>();
    for(const row of this.db.prepare('SELECT id,parentId,type,name,status,permissions FROM nodes ORDER BY rowid').all()){
      const n=row as Omit<PolicyNode,'permissions'> & {permissions:string};
      index.set(n.id,{...n,permissions:JSON.parse(n.permissions)});
    }
    const lookup=(id:string)=>index.get(id);
    const ownerPath=(owner:PolicyNode)=>({rules:owner.permissions,ids:lineage(owner,lookup).map(n=>n.id)});
    const paths=(subject:NodeRecord)=>({id:subject.id,paths:this.paths(subject).map(chain=>chain.map(ownerPath))});
    const subjects=[paths(actor)];
    for (const layer of ctx ?? []) {
      for (const id of layer.subjects) subjects.push(paths(this.get(id)!));
      if (layer.permissions) subjects.push({id:actorId,paths:[[{...ownerPath(actor),rules:layer.permissions}]]});
    }
    const entries=new Map<string,DirectoryEntry>();
    for(const node of index.values()) {
      const chain=lineage(node,lookup), ids=chain.map(n=>n.id);
      if(!subjects.every(subject=>subject.paths.some(path=>path.every(o=>
        allowsAtLevel(o.rules,o.ids,ids,node.type,subject.id,undefined,'discover',undefined,undefined,this.member))))) continue;
      for(const n of chain.reverse()) if(!entries.has(n.id)) {
        const {id,parentId,type,name,status}=n;
        entries.set(id,{id,parentId,type,name,...(['app','user','profile'].includes(type)?{status}:{})});
      }
    }
    return [...entries.values()];
  }
}
