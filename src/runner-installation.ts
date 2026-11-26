import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { compilePolicySchema } from './policy-schema.ts';

export function installationDirectory(root:string,name:string) {
  const directory=join(root,name);
  if (realpathSync(root)!==root || realpathSync(directory)!==directory || !lstatSync(directory).isDirectory())
    throw Error('Expected a private runner installation directory');
  return directory;
}
export function checkedEntrypoint(root:string,name:string,value:unknown) {
  if (typeof value!=='string' || !isAbsolute(value) || resolve(value)!==value) throw Error('Expected an absolute runner entrypoint');
  const directory=installationDirectory(root,name);
  const entrypoint=realpathSync(value);
  if (![value,entrypoint].every(path=>path.startsWith(directory+sep)) || !statSync(entrypoint).isFile())
    throw Error('Entrypoint must be a file in the named runner directory');
  return entrypoint;
}
export function preparedRelease(directory:string,entrypoint:string|null) {
  if (!entrypoint) return;
  const [releases,id,...tail]=relative(directory,entrypoint).split(sep);
  if (releases!=='releases' || !id || !tail.length) return;
  const release=join(directory,releases,id);
  const stamp=join(release,'source.json');
  if (!existsSync(stamp)) return;
  try {
    if (realpathSync(stamp)!==stamp || statSync(stamp).size>16384) return;
    const source=JSON.parse(readFileSync(stamp,'utf8'));
    if (!['npm','git'].includes(source.type) || typeof source.spec!=='string' ||
        resolve(release,source.entrypoint)!==entrypoint) return;
    return {release,source:{type:source.type,spec:source.spec,...(typeof source.ref==='string' && {ref:source.ref})}};
  } catch { return; }
}

export type RunnerMethod = {type:'method';version:string;description:string;schema?:{input?:unknown;output?:unknown}};
export function runnerContract(payload:any) {
  if (!payload || typeof payload!=='object' || Array.isArray(payload) ||
      (payload.methods!==undefined && (!payload.methods || typeof payload.methods!=='object' || Array.isArray(payload.methods))))
    throw Error('Invalid runner declaration');
  const methods=new Map<string,RunnerMethod>();
  for (const [name,value] of Object.entries(payload.methods ?? {})) {
    const method=value as RunnerMethod;
    if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/.test(name) || typeof method?.description!=='string' || methods.size>=128)
      throw Error('Invalid runner method');
    for (const schema of Object.values(method.schema ?? {})) compilePolicySchema(schema);
    methods.set(name,{type:'method',version:method.version ?? '1',description:method.description,schema:method.schema});
  }
  if (payload.settingsSchema!==undefined) compilePolicySchema(payload.settingsSchema);
  return {methods,settingsSchema:payload.settingsSchema,kind:payload.kind as string|undefined};
}
