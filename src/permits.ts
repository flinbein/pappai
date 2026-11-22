import { lstatSync } from 'node:fs';
import { posix } from 'node:path';
import {compilePolicySchema,type ResolveNodes} from './policy-schema.ts';

export type NodeType = 'workspace' | 'team' | 'user' | 'app';
export type NodeSelector = string | boolean;
type NameSelector = string | string[] | boolean;
type MessageSelector = NameSelector | Record<string, unknown>;
type PathSelector = string | string[] | boolean;
export type Rule = {
  node?: NodeSelector | NodeSelector[];
  nodeType?: NodeType | NodeType[];
  methods?: MessageSelector;
  events?: MessageSelector;
  discover?: boolean;
  delivery?: boolean;
  network?: boolean;
  http?: boolean;
  read?: PathSelector;
  write?: PathSelector;
  deny?: boolean;
};
export type Permissions = Rule[] | null;

const nodeTypes = ['workspace', 'team', 'user', 'app'];
const knownFields = new Set(['node','nodeType','methods','events','discover','delivery','network','http','read','write','deny']);
const nodePattern = /^(?:@|(?:~|[A-Za-z0-9_-]+|\.|\.\.(?:\/\.\.)*)(?:\/(?:\*{1,2}|&))?)$/;

function list<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

export function validNodes(value: NodeSelector | NodeSelector[]): boolean {
  const selectors = list(value);
  return selectors.every((s, index) => {
    if (typeof s === 'boolean') return true;
    if (typeof s !== 'string') return false;
    if (s.startsWith('!')) return index < selectors.length - 1 && nodePattern.test(s.slice(1));
    return nodePattern.test(s);
  });
}

function validNames(value: NameSelector): boolean {
  return typeof value === 'boolean' || list(value).every(name => typeof name === 'string' &&
    name.split('.').every((part, i, parts) => /^[\w$-]+$/.test(part) || part === '*' ||
      (part === '**' && i === parts.length - 1)));
}

export function validateSchemaSelector(node: any, types?: any) {
  if (!validNodes(node) || list(node).some(s => s === '@' || s === '!@')) throw Error('Invalid schema node selector');
  if (types !== undefined && !list(types).every(t => nodeTypes.includes(t))) throw Error('Invalid schema nodeType');
}

function validateMessages(filter: any) {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
    if (!validNames(filter)) throw Error('Invalid message selector');
    return;
  }
  for (const [pattern,condition] of Object.entries(filter)) {
    if (!validNames(pattern)) throw Error('Invalid message name');
    for (const schema of list(condition)) {
      if (schema === '*' || typeof schema === 'boolean') continue;
      compilePolicySchema(schema,(selector,types) => {validateSchemaSelector(selector,types); return ['schema-validation'];});
    }
  }
}

function validPaths(value: PathSelector): boolean {
  return typeof value === 'boolean' || list(value).every(path => typeof path === 'string' &&
    posix.isAbsolute(path) && posix.normalize(path) === path && !path.includes('\0'));
}

function checkExistingComponents(path: string) {
  // These are container paths. Desktop development cannot resolve them on
  // the Windows host. On Linux, launch checks the complete mount again.
  if (process.platform !== 'linux') return;
  let component = '';
  for (const part of path.split('/').filter(Boolean)) {
    component += '/' + part;
    let entry;
    try { entry = lstatSync(component); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (entry.isSymbolicLink()) throw Error('Symbolic links are not allowed in filesystem permits: ' + component);
  }
}

export function validatePermissions(value: unknown): asserts value is Permissions {
  if (value === null) return;
  if (!Array.isArray(value)) throw new Error('Permissions must be an array or null');
  for (const rule of value) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule) ||
        Object.keys(rule).some(k => !knownFields.has(k))) throw new Error('Unsupported permission rule');
    for (const field of ['discover','delivery','network','http','deny']) {
      if (field in rule && typeof rule[field] !== 'boolean') throw new Error('Invalid ' + field + ' permission');
    }
    if ('node' in rule && !validNodes(rule.node)) throw new Error('Unsupported node selector');
    if ('nodeType' in rule && !list(rule.nodeType).every(t => nodeTypes.includes(t))) {
      throw new Error('Invalid node type');
    }
    for (const field of ['methods','events']) {
      if (field in rule) validateMessages(rule[field]);
    }
    for (const field of ['read','write']) {
      if (field in rule && !validPaths(rule[field])) throw new Error('Invalid ' + field + ' path');
      for (const path of paths(rule[field])) {
        if (['/proc','/dev','/sys','/tmp','/run'].some(root => contains(root,path))) throw Error('Reserved system path');
        checkExistingComponents(path);
      }
    }
  }
}

function matchesNode(base: string, owners: string[], targets: string[], actorId: string, member: (team:string,id:string)=>boolean): boolean {
  if (base === '@') return targets[0] === actorId;
  const end = base.match(/\/(\*{1,2}|&)$/);
  const selector = end ? base.slice(0, -end[0].length) : base;
  let id = selector;
  if (selector === '.') id = owners[0];
  else if (selector.startsWith('..')) id = owners[selector.split('/').length];
  if (end?.[1] === "&") return member(id,targets[0]);
  const distance = targets.indexOf(id);
  if (!end) return distance === 0;
  return end[1] === '*' ? distance === 1 : distance > 0;
}

export function selectsNode(rule: Pick<Rule,"node"|"nodeType">, owners: string[], targets: string[], type: NodeType, actorId: string, member: (team:string,id:string)=>boolean = () => false): boolean {
  if (rule.nodeType !== undefined && !list(rule.nodeType).includes(type)) return false;
  for (const token of list(rule.node ?? true)) {
    if (token === true) return true;
    if (token === false) continue;
    const negative = token.startsWith('!');
    if (matchesNode(negative ? token.slice(1) : token, owners, targets, actorId, member)) return !negative;
  }
  return false;
}

export function matchesName(filter: NameSelector | undefined, method: string): boolean {
  if (filter === true) return true;
  if (!filter) return false;
  const parts = method.split('.');
  return list(filter).some(pattern => {
    const mask = pattern.split('.');
    const recursive = mask.at(-1) === '**';
    if (recursive ? parts.length < mask.length : parts.length !== mask.length) return false;
    return mask.every((part, i) => part === '*' || part === '**' || part === parts[i]);
  });
}

export type Capability = 'methods'|'events'|'http'|'network'|'delivery'|'discover';
export function allowsAtLevel(rules: Permissions, owners: string[], targets: string[], targetType: NodeType,
    actorId: string, method?: string, capability: Capability = method === undefined ? 'discover' : 'methods',
    data?: unknown, resolve?: ResolveNodes, member?: (team:string,id:string)=>boolean): boolean {
  if (rules === null) return true;
  for (const rule of rules) {
    const mask = rule[capability];
    if (!mask || !selectsNode(rule,owners,targets,targetType,actorId,member)) continue;
    if (method !== undefined) {
      if (typeof mask === 'object' && !Array.isArray(mask)) {
        const matched = Object.entries(mask).some(([name,condition]) => matchesName(name,method) &&
          list(condition).some(schema => {
            if (schema === '*') return true;
            try { return compilePolicySchema(schema,resolve)(data); } catch { return !!rule.deny; }
          }));
        if (!matched) continue;
      } else if (!matchesName(mask as NameSelector,method)) continue;
    }
    return !rule.deny;
  }
  return false;
}

function paths(value: PathSelector | undefined): string[] {
  if (value === true) return ['/'];
  if (!value) return [];
  return list(value).map(path => path === '/' ? path : path.replace(/\/$/, ''));
}

function contains(root: string, path: string): boolean {
  return root === '/' || path === root || path.startsWith(root + '/');
}

export const minimalPaths = ['/bin','/sbin','/lib','/usr','/etc'];
export function fileLevel(rules: Permissions, path: string): number {
  if (rules === null) return 2;
  let read: boolean | undefined, write: boolean | undefined;
  for (const rule of rules) {
    const r = paths(rule.read).some(root => contains(root,path));
    const w = paths(rule.write).some(root => contains(root,path));
    if (r || (w && !rule.deny)) read ??= !rule.deny;
    if (w || (r && rule.deny)) write ??= !rule.deny;
    if (read !== undefined && write !== undefined) break;
  }
  read ??= minimalPaths.some(root => contains(root,path));
  return read ? (write ? 2 : 1) : 0;
}

export function filesystemProfile(chains: Permissions[][]) {
  if (chains.some(chain => chain.every(r => r === null))) return null;
  const anchors = new Set<string>(minimalPaths);
  for (const chain of chains) for (const rules of chain) for (const rule of rules ?? []) {
    for (const path of [...paths(rule.read),...paths(rule.write)]) anchors.add(path);
  }
  const levels = new Map<string,number>();
  const read: string[] = [], write: string[] = [], hide: string[] = [];
  for (const path of [...anchors].sort((a,b) => a.length-b.length)) {
    const level = Math.max(...chains.map(chain => Math.min(...chain.map(rules => fileLevel(rules,path)))));
    let inherited = minimalPaths.includes(path) ? 1 : 0;
    for (const [parent,l] of levels) if (contains(parent,path)) inherited = l;
    // The runner always supplies the minimal mounts, even under a broader parent.
    if (minimalPaths.includes(path) && !levels.get('/')) inherited = 1;
    levels.set(path,level);
    if (level !== inherited) (level === 2 ? write : level === 1 ? read : hide).push(path);
  }
  const network = chains.some(chain => chain.every(rules =>
    rules === null || rules.filter(r => r.network).slice(0,1).some(r => !r.deny)));
  return {read,write,network,...(hide.length ? {hide} : {})};
}
export function sandboxFor(chain: Permissions[]) { return filesystemProfile([chain]); }
