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
export type ProfileCli = {type:'cli';version:string;description:string;doc?:string;schema?:{input?:unknown}};
const featureName=/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/;
function record(value:unknown):value is Record<string,unknown> {
  return value!==null && typeof value==='object' && !Array.isArray(value);
}
export function runnerContract(payload:any) {
  if (!payload || typeof payload!=='object' || Array.isArray(payload) ||
      (payload.methods!==undefined && (!payload.methods || typeof payload.methods!=='object' || Array.isArray(payload.methods))))
    throw Error('Invalid runner declaration');
  const methods=new Map<string,RunnerMethod>();
  for (const [name,value] of Object.entries(payload.methods ?? {})) {
    const method=value as RunnerMethod;
    if (!featureName.test(name) || typeof method?.description!=='string' || methods.size>=128)
      throw Error('Invalid runner method');
    for (const schema of Object.values(method.schema ?? {})) compilePolicySchema(schema);
    methods.set(name,{type:'method',version:method.version ?? '1',description:method.description,schema:method.schema});
  }
  if (payload.settingsSchema!==undefined) compilePolicySchema(payload.settingsSchema);
  const profileCli=new Map<string,ProfileCli>();
  if (payload.profileCli!==undefined && !record(payload.profileCli)) throw Error('Invalid PROFILE CLI declaration');
  for (const [name,value] of Object.entries(payload.profileCli ?? {})) {
    if (profileCli.size>=128 || !featureName.test(name) || !record(value) || typeof value.description!=='string' ||
        (value.version!==undefined && (typeof value.version!=='string' || !value.version)) ||
        (value.doc!==undefined && typeof value.doc!=='string') ||
        (value.schema!==undefined && (!record(value.schema) || Object.keys(value.schema).some(key=>key!=='input'))))
      throw Error('Invalid PROFILE CLI feature');
    const {schema,description,doc,version}=value;
    if (schema?.input!==undefined) compilePolicySchema(schema.input);
    profileCli.set(name,{type:'cli',description,version:version ?? '1',doc,schema});
  }
  return {methods,profileCli,settingsSchema:payload.settingsSchema,kind:payload.kind as string|undefined};
}

// Only files in this administrator-installed runner's directory may become private mounts.
export function cliLaunchPlan(root:string,name:string,reply:unknown) {
  if (!record(reply) || !Array.isArray(reply.files) || reply.files.length>32 || !Array.isArray(reply.argv) ||
      !reply.argv.length || reply.argv.length>256 || !reply.argv.every(arg=>typeof arg==='string' && !arg.includes('\0')) ||
      !reply.argv[0] || Buffer.byteLength(JSON.stringify(reply.argv))>65536) throw Error('Invalid CLI launch plan');
  if (reply.env!==undefined && (!record(reply.env) || !Object.entries(reply.env).every(([key,value])=>
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !key.startsWith('PAPPAI_') && typeof value==='string' && !value.includes('\0'))))
    throw Error('Invalid CLI environment');
  if (reply.calls!==undefined && (!Array.isArray(reply.calls) || reply.calls.length>64 ||
      !reply.calls.every(key=>typeof key==='string' && featureName.test(key)))) throw Error('Invalid PROFILE CLI calls');
  return {files:reply.files.map(file=>checkedEntrypoint(root,name,file)),argv:reply.argv as string[],
    calls:reply.calls as string[]|undefined,
    ...(reply.env && {env:reply.env as Record<string,string>})};
}
