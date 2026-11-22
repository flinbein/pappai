import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { allowsAtLevel, sandboxFor, validatePermissions } from './permits.ts';
import type { NodeType, Permissions } from './permits.ts';

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
  lastIssue: string | null;
};

type NodeSettings = {name: string; email?: string; permissions?: unknown; manifest?: unknown};
type SqlNode = Omit<NodeRecord,'permissions'|'manifest'> & {permissions: string; manifest: string | null};
export type DirectoryEntry = Pick<NodeRecord,'id'|'parentId'|'type'|'name'> & {status?: NodeStatus};
type PolicyNode = Pick<NodeRecord,'id'|'parentId'|'type'|'name'|'status'|'permissions'>;

function decode(row: SqlNode): NodeRecord {
  return {...row, permissions: JSON.parse(row.permissions), manifest: row.manifest ? JSON.parse(row.manifest) : null};
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

function permitsTarget(owners: PolicyNode[], targets: string[], type: NodeType, method?: string) {
  const ids = owners.map(node => node.id);
  return owners.every((owner, i) => allowsAtLevel(owner.permissions, ids.slice(i), targets, type, ids[0], method));
}

function activeCaller(node: PolicyNode | undefined): node is PolicyNode {
  return !!node && (node.type === 'user' || node.type === 'app') && node.status === 'working';
}

export class Store {
  readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS store_migrations(version INTEGER PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS nodes (
          id TEXT PRIMARY KEY, parentId TEXT REFERENCES nodes(id), type TEXT NOT NULL,
          name TEXT NOT NULL, status TEXT NOT NULL, email TEXT UNIQUE, permissions TEXT NOT NULL,
          manifest TEXT, lastIssue TEXT,
          CHECK(type IN ('workspace','team','user','app')),
          CHECK(status IN ('working','stopped','stopping','error')),
          CHECK((type='workspace') = (id='~')),
          CHECK((type='workspace') = (parentId IS NULL)),
          CHECK((type='user') = (email IS NOT NULL)),
          CHECK(type!='workspace' OR permissions='null')
        ) STRICT;
        CREATE INDEX IF NOT EXISTS nodes_parent ON nodes(parentId);
        INSERT INTO nodes(id,type,name,status,permissions) VALUES('~','workspace','workspace','working','null')
          ON CONFLICT(id) DO NOTHING;
        INSERT OR IGNORE INTO store_migrations VALUES (1);
      `);
      if (db.prepare('SELECT MAX(version) AS version FROM store_migrations').get()?.version !== 1) {
        throw new Error('Unsupported workspace database version');
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  get(id: string): NodeRecord | undefined {
    const row = this.db.prepare('SELECT * FROM nodes WHERE id=?').get(id);
    return row ? decode(row as SqlNode) : undefined;
  }

  byEmail(email: string): NodeRecord | undefined {
    const row = this.db.prepare('SELECT * FROM nodes WHERE email=?').get(emailKey(email));
    return row ? decode(row as SqlNode) : undefined;
  }

  create(parentId: string, type: Exclude<NodeType,'workspace'>, settings: NodeSettings): NodeRecord {
    if (!['team','user','app'].includes(type)) throw new Error('Unsupported node type');
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
    const row = this.db.prepare(`
      INSERT INTO nodes(id,parentId,type,name,status,email,permissions,manifest)
      VALUES(?,?,?,?,?,?,?,?) RETURNING *
    `).get(randomUUID(), parentId, type, settings.name, type === 'team' ? 'working' : 'stopped',
      email, JSON.stringify(permissions), type === 'app' ? JSON.stringify(settings.manifest) : null);
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

  workingApps(): NodeRecord[] {
    return this.db.prepare("SELECT * FROM nodes WHERE type='app' AND status='working'").all().map(row => decode(row as SqlNode));
  }

  private chain(node: NodeRecord) {
    return lineage(node, id => this.get(id));
  }

  isAdmin(actorId: string): boolean {
    const actor = this.get(actorId);
    return activeCaller(actor) &&
      this.chain(actor).every(node => node.permissions === null);
  }

  sandbox(nodeId: string) {
    const app = this.get(nodeId);
    if (!app || (app.type !== 'app' && app.type !== 'user')) throw new Error('Unknown APP or USER');
    return sandboxFor(this.chain(app).map(node => node.permissions));
  }

  private permitted(actorId: string, targetId: string, method?: string): boolean {
    const actor = this.get(actorId);
    const target = this.get(targetId);
    if (!activeCaller(actor) || !target) return false;
    const targets = this.chain(target).map(node => node.id);
    return permitsTarget(this.chain(actor), targets, target.type, method);
  }

  allows(actorId: string, targetId: string, method: string): boolean {
    return typeof method === 'string' && !!method && this.permitted(actorId, targetId, method);
  }

  canDiscover(actorId: string, targetId: string): boolean {
    return this.permitted(actorId, targetId);
  }

  visible(actorId: string): DirectoryEntry[] {
    // One consistent directory view. Credentials, manifests and issues never enter the projection.
    const index = new Map<string, PolicyNode>();
    for (const raw of this.db.prepare('SELECT id,parentId,type,name,status,permissions FROM nodes ORDER BY rowid').all()) {
      const node = raw as Omit<PolicyNode,'permissions'> & {permissions:string};
      index.set(node.id, {...node, permissions:JSON.parse(node.permissions)});
    }
    const actor = index.get(actorId);
    if (!activeCaller(actor)) return [];
    const lookup = (id: string) => index.get(id);
    const owners = lineage(actor, lookup);
    const visible = new Map<string, DirectoryEntry>();
    for (const node of index.values()) {
      const targets = lineage(node, lookup);
      if (!permitsTarget(owners, targets.map(n => n.id), node.type)) continue;
      for (const ancestor of targets.reverse()) {
        if (visible.has(ancestor.id)) continue;
        const {id,parentId,type,name,status} = ancestor;
        const entry: DirectoryEntry = {id,parentId,type,name};
        if (type === 'app' || type === 'user') entry.status = status;
        visible.set(id,entry);
      }
    }
    return [...visible.values()];
  }
}
