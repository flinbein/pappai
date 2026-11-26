import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { matchesName } from './permits.ts';

// Check both catalogs. A wildcard may stop matching a deny, or start matching a new grant.
const methods = [
  '$.team.create', '$.user.create', '$.app.create', '$.profile.create',
  '$.children.createTeam', '$.children.createUser', '$.children.createApp', '$.children.createProfile',
  '$.app.start', '$.app.stop', '$.profile.enable', '$.profile.disable', '$.profile.get', '$.app.get',
  '$.lifecycle.start', '$.lifecycle.stop', '$.lifecycle.get', '$.app.forceStart', '$.node.get', '$.profile.scope.get',
  '$.node.permissions.get', '$.node.permissions.set', '$.permissions.get', '$.permissions.set',
  '$.team.members.add', '$.team.members.delete', '$.team.members.remove',
  '$.app.memberships.list', '$.app.memberships.add', '$.app.memberships.delete', '$.memberships.list',
  ...['get','set','add','delete','enable','disable'].map(name=>'$.node.subscriptions.' + name),
  ...['get','set','add','remove','enable','disable'].map(name=>'$.subscriptions.' + name),
  '$.runners.get', '$.runners.list',
];
const events = [
  '$.app.statusChanged', '$.lifecycle.statusChanged', '$.node.lastIssueUpdated', '$.app.lastIssueChanged',
  '$.app.executor.failed', '$.app.executors.failed', '$.node.subscriptions.updated', '$.subscriptions.changed',
  '$.node.permissions.updated', '$.permissions.changed', '$.effectivePermissions.invalidated',
];

type Finding = {node:string; location:string; effect:string; names?:string[]};

function inspectRules(findings:Finding[],node:string,location:string,rules:any,subscriptions=false) {
  if (rules == null) return;
  if (!Array.isArray(rules)) throw Error('Invalid rule list at '+node+' '+location);
  rules.forEach((rule,index)=>{
    for (const field of (subscriptions ? ['events'] : ['methods','events'])) {
      const selector = subscriptions && !Object.hasOwn(rule,field) ? true : rule[field];
      const patterns = selector && typeof selector==='object' && !Array.isArray(selector)
        ? Object.keys(selector) : selector;
      const names = (field==='methods' ? methods : events).filter(name=>matchesName(patterns,name));
      if (names.length) findings.push({node,location:`${location}[${index}].${field}`,
        effect:rule.deny ? 'deny' : subscriptions ? 'subscribe' : 'allow',names});
    }
  });
}

function parse(value:unknown,node:string,location:string) {
  try { return JSON.parse(String(value)); }
  catch { throw Error('Invalid JSON at '+node+' '+location); }
}

export function catalogUpgradeFindings(db:DatabaseSync) {
  const findings:Finding[]=[];
  const table=(name:string)=>db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name);
  for (const row of db.prepare('SELECT id,permissions,manifest FROM nodes ORDER BY id').iterate()) {
    const node=String(row.id);
    inspectRules(findings,node,'permissions',parse(row.permissions,node,'permissions'));
    if (row.manifest!==null) {
      const manifest=parse(row.manifest,node,'manifest');
      inspectRules(findings,node,'manifest.subscriptions',manifest?.subscriptions,true);
    }
  }
  if (table('personal_subscriptions')) {
    for (const row of db.prepare('SELECT node,rules FROM personal_subscriptions ORDER BY node').iterate()) {
      const node=String(row.node);
      inspectRules(findings,node,'personal_subscriptions',parse(row.rules,node,'personal_subscriptions'),true);
    }
  }
  if (table('manifest_sources')) {
    for (const row of db.prepare('SELECT appId,source FROM manifest_sources ORDER BY appId').iterate()) {
      const node=String(row.appId), source=parse(row.source,node,'manifest_sources.source');
      if ('file' in source) {
        findings.push({node,location:'source.file',effect:'review publisher file'});
        inspectRules(findings,node,'source.override.subscriptions',source.override?.subscriptions,true);
      } else inspectRules(findings,node,'source.manifest.subscriptions',source.manifest?.subscriptions,true);
    }
  }
  return findings;
}

if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length!==3) throw Error('Usage: node src/catalog-upgrade.ts <workspace.sqlite>');
  const db=new DatabaseSync(process.argv[2],{readOnly:true});
  try {
    db.exec('BEGIN');
    console.log(JSON.stringify(catalogUpgradeFindings(db),null,2));
  } finally { db.close(); }
}
