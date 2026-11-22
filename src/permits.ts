import { posix } from 'node:path';

export type NodeType = 'workspace' | 'team' | 'user' | 'app';
type NodeSelector = string | boolean;
type NameSelector = string | string[] | boolean;
type PathSelector = string | string[] | boolean;
export type Rule = {
  node?: NodeSelector | NodeSelector[];
  nodeType?: NodeType | NodeType[];
  methods?: NameSelector;
  events?: NameSelector;
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
const nodePattern = /^(?:@|(?:~|[A-Za-z0-9_-]+|\.|\.\.(?:\/\.\.)*)(?:\/\*{1,2})?)$/;

function list<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

function validNodes(value: NodeSelector | NodeSelector[]): boolean {
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

function validPaths(value: PathSelector): boolean {
  return typeof value === 'boolean' || list(value).every(path => typeof path === 'string' &&
    posix.isAbsolute(path) && posix.normalize(path) === path && !path.includes('\0'));
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
      if (field in rule && !validNames(rule[field])) throw new Error('Unsupported ' + field + ' selector');
    }
    for (const field of ['read','write']) {
      if (field in rule && !validPaths(rule[field])) throw new Error('Invalid ' + field + ' path');
      if (rule.deny && rule[field] && paths(rule[field]).length) throw new Error('Filesystem deny rules not yet supported');
    }
    if (('node' in rule || 'nodeType' in rule) &&
        ('read' in rule || 'write' in rule || 'network' in rule)) {
      throw new Error('Addressed filesystem/network rules not yet supported');
    }
  }
}

function matchesNode(base: string, owners: string[], targets: string[], actorId: string): boolean {
  if (base === '@') return targets[0] === actorId;
  const end = base.match(/\/(\*{1,2})$/);
  const selector = end ? base.slice(0, -end[0].length) : base;
  let id = selector;
  if (selector === '.') id = owners[0];
  else if (selector.startsWith('..')) id = owners[selector.split('/').length];
  const distance = targets.indexOf(id);
  if (!end) return distance === 0;
  return end[1] === '*' ? distance === 1 : distance > 0;
}

function selectsNode(rule: Rule, owners: string[], targets: string[], type: NodeType, actorId: string): boolean {
  if (rule.nodeType !== undefined && !list(rule.nodeType).includes(type)) return false;
  for (const token of list(rule.node ?? true)) {
    if (token === true) return true;
    if (token === false) continue;
    const negative = token.startsWith('!');
    if (matchesNode(negative ? token.slice(1) : token, owners, targets, actorId)) return !negative;
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

export function allowsAtLevel(rules: Permissions, owners: string[], targets: string[], targetType: NodeType,
    actorId: string, method?: string): boolean {
  if (rules === null) return true;
  for (const rule of rules) {
    if (!(method === undefined ? rule.discover : matchesName(rule.methods, method))) continue;
    if (selectsNode(rule, owners, targets, targetType, actorId)) return !rule.deny;
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

function intersect(previous: string[], grants: string[]): string[] {
  const narrowed = new Set<string>();
  for (const a of previous) for (const b of grants) {
    if (contains(a,b)) narrowed.add(b);
    else if (contains(b,a)) narrowed.add(a);
  }
  const scope = [...narrowed];
  return scope.filter(path => !scope.some(parent => parent !== path && contains(parent,path)));
}

export function sandboxFor(chain: Permissions[]) {
  if (chain.every(rules => rules === null)) return null;
  let read = ['/'], write = ['/'], network = true;
  for (const rules of chain) {
    if (rules === null) continue;
    const readGrants = rules.flatMap(rule => paths(rule.read));
    const writeGrants = rules.flatMap(rule => paths(rule.write));
    read = intersect(read, [...readGrants, ...writeGrants]);
    write = intersect(write, writeGrants);
    const matched = rules.find(rule => rule.network);
    network = network && !!matched && !matched.deny;
  }
  return {read:read.filter(path => !write.some(parent => contains(parent,path))), write, network};
}
