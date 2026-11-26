import { compileSchema } from './manifest.ts';
import { matchesName, validatePermissions } from './permits.ts';

type Filter = {
  id?: string; node?: any; nodeType?: any; caughtBy?: any;
  matches: (event: string, data: unknown) => boolean;
  priority: number; canEvict: boolean; deny: boolean; enabled: boolean;
};
const fields = new Set(['id','description','node','nodeType','events','caughtBy','priority','canEvict','deny','enabled']);

export function compileSubscriptions(rules: unknown, personal = false): Filter[] {
  if (!Array.isArray(rules) || rules.length > 512) throw Error('Expected up to 512 subscriptions');
  const ids = new Set<string>();
  return rules.map(rule => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule) || Object.keys(rule).some(k => !fields.has(k)))
      throw Error('Invalid subscription');
    if (personal) {
      if (typeof rule.id !== 'string' || !rule.id.length || rule.id.length > 255 || ids.has(rule.id))
        throw Error('Invalid or duplicate subscription id');
      ids.add(rule.id);
    } else if ('id' in rule) throw Error('Manifest subscription cannot declare an id');
    if ('description' in rule && typeof rule.description !== 'string') throw Error('Invalid subscription description');
    for (const key of ['canEvict','deny','enabled'])
      if (key in rule && typeof rule[key] !== 'boolean') throw Error('Invalid subscription ' + key);
    if (rule.canEvict && rule.deny) throw Error('Deny subscription cannot evict');
    if ('priority' in rule && !Number.isSafeInteger(rule.priority)) throw Error('Invalid subscription priority');
    if ('node' in rule) validatePermissions([{node:rule.node}]);
    if ('nodeType' in rule) validatePermissions([{nodeType:rule.nodeType}]);
    if ('caughtBy' in rule) validatePermissions([{node:rule.caughtBy}]);
    const selector = Object.hasOwn(rule,'events') ? rule.events : true;
    let matches: Filter['matches'];
    if (selector && typeof selector === 'object' && !Array.isArray(selector)) {
      const filters = Object.entries(selector).map(([pattern, schemas]) => {
        validatePermissions([{events:pattern}]);
        const checks = (Array.isArray(schemas) ? schemas : [schemas]).map(s => {
          if (s === '*') return () => true;
          if (typeof s !== 'boolean' && (!s || typeof s !== 'object' || Array.isArray(s))) throw Error('Invalid subscription schema');
          return compileSchema(s)!;
        });
        const rank = pattern.split('.').map(part=>part === '**' ? '0' : part === '*' ? '1' : '2').join('');
        return {pattern, checks, rank};
      });
      filters.sort((a,b)=>b.rank.localeCompare(a.rank));
      matches = (name,data) => filters.find(({pattern})=>matchesName(pattern,name))?.checks.some(check => {
        try { return check(data); } catch { return !!rule.deny; }
      }) ?? false;
    } else {
      validatePermissions([{events:selector}]);
      matches = name => matchesName(selector,name);
    }
    return {id:rule.id,node:rule.node,nodeType:rule.nodeType,caughtBy:rule.caughtBy,
      priority:rule.priority ?? 0,canEvict:rule.canEvict ?? false,deny:rule.deny ?? false,
      enabled:rule.enabled ?? true,matches};
  });
}

export function changeSubscriptions(existing: any[], action: string, data: any): any[] {
  let next: any[];
  if (action === 'set') next = data.subscriptions;
  else if (action === 'add') {
    const {before,after,subscriptions} = data;
    if (!Array.isArray(subscriptions) || (before !== undefined && after !== undefined)) throw Error('Invalid subscription insertion');
    const anchor = before ?? after;
    let offset = before === true ? 0 : existing.length;
    if (anchor !== true && anchor !== undefined) {
      const found = existing.findIndex(rule => rule.id === anchor);
      if (found < 0) throw Error('Subscription not found');
      offset = found + (after !== undefined ? 1 : 0);
    }
    next = [...existing.slice(0,offset),...subscriptions,...existing.slice(offset)];
  } else {
    if (!['enable','disable','remove'].includes(action)) throw Error('Unknown subscription operation');
    if (!Array.isArray(data.ids) || data.ids.some((id:unknown) => !existing.some(rule => rule.id === id)))
      throw Error('Subscription not found');
    const ids = new Set(data.ids);
    if (action === 'remove') next = existing.filter(rule => !ids.has(rule.id));
    else next = existing.map(rule => ids.has(rule.id) && (rule.enabled ?? true) !== (action === 'enable')
      ? {...rule,enabled:action === 'enable'} : rule);
  }
  compileSubscriptions(next,true);
  return next;
}
