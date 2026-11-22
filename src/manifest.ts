import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { isAbsolute } from 'node:path';
import { compilePolicySchema } from './policy-schema.ts';
import { compileSubscriptions } from './subscriptions.ts';
import type { RunnerSettings } from './runner.ts';

const ajv = new Ajv2020({ strict: true, addUsedSchema: false, ownProperties: true });
addFormats(ajv);

const schemaSlot = { anyOf: [{ type: 'object' }, { type: 'boolean' }] };
const duration = { type: 'integer', minimum: 1, maximum: 2147483647 };
const sharedSettings = {
  env: {
    type: 'object',
    propertyNames: { pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
    additionalProperties: {
      anyOf: [{ type: 'string' }, { type: 'object', required: ['secret'],
        additionalProperties: false, properties: { secret: { type: 'string' } } }],
    },
  },
  features: {
    type: 'object',
    maxProperties: 512,
    propertyNames: { pattern: '^[A-Za-z0-9_-]+(\\.[A-Za-z0-9_-]+)*$' },
    additionalProperties: {
      type: 'object',
      required: ['description', 'version'],
      additionalProperties: false,
      properties: {
        type: { enum: ['doc', 'method', 'event'] },
        priority: { type: 'integer' },
        canEvict: { type: 'boolean' },
        description: { type: 'string', maxLength: 255 },
        version: { type: 'string', minLength: 1 },
        doc: { type: 'string' },
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { input: schemaSlot, output: schemaSlot, data: schemaSlot },
        },
      },
    },
  },
};
const processSettings = {
  type: 'object',
  additionalProperties: false,
  required: ['command','cwd','features'],
  properties: {
    ...sharedSettings,
    command: { type:'string', minLength:1 },
    cwd: { type:'string', minLength:1 },
    args: { type:'array', items:{type:'string'} },
  },
};
const schema = {
  type: 'object', additionalProperties: false, required: ['run','executors'],
  properties: {
    subscriptions: { type:'array' },
    executors: {
      type: 'object',
      additionalProperties: false,
      required: ['mode'],
      properties: {
        mode: { enum: ['oneShot', 'persistent'] },
        poolSize: { type: 'integer', minimum: 1, maximum: 20 },
        maxLifetimeMs: duration,
        idleTimeoutMs: { anyOf: [duration, { type: 'null' }] },
        maxRestarts: { type: 'integer', minimum: 0, maximum: 10 },
      },
    },
    run: {
      type:'object', additionalProperties:false, required:['type','settings'],
      properties: {
        type: {type:'string', pattern:'^[a-z][a-z0-9_-]{0,63}$'},
        settings: {type:'object', properties:sharedSettings},
      },
    },
  },
};
type ManifestSettings = Record<string,unknown> & {
  env?: Record<string, string | {secret: string}>; features?: Record<string, any>;
};
type Manifest = {
  run: { type: string; settings: ManifestSettings };
  subscriptions?: unknown[];
  executors: { mode: 'oneShot'|'persistent'; poolSize?: number; maxLifetimeMs?: number; idleTimeoutMs?: number|null; maxRestarts?: number };
};
const validate = ajv.compile<Manifest>(schema);
const checkProcessSettings = ajv.compile<ManifestSettings & {command:string;cwd:string;args?:string[]}>(processSettings);

export function compileSchema(value: any) {
  return value === undefined ? undefined : compilePolicySchema(value);
}
export function prepare(source: any) {
  if (!validate(source)) throw Error('Invalid inline manifest: ' + ajv.errorsText(validate.errors));
  const { settings } = source.run;
  const {mode, poolSize = 1, maxLifetimeMs, idleTimeoutMs} = source.executors;
  if (mode === 'persistent' && ('poolSize' in source.executors || maxLifetimeMs !== undefined))
    throw Error('poolSize and maxLifetimeMs apply only to oneShot');
  if (mode === 'oneShot' && (idleTimeoutMs !== undefined || source.executors.maxRestarts !== undefined))
    throw Error('idleTimeoutMs and maxRestarts apply only to persistent');
  const features = new Map<
    string,
    {
      description: string;
      version: string;
      type: string;
      doc?: string;
      schema?: any;
      input?: ReturnType<typeof compileSchema>;
      output?: ReturnType<typeof compileSchema>;
      data?: ReturnType<typeof compileSchema>;
      priority?: number;
      canEvict?: boolean;
    }
  >();
  for (const [name, entry] of Object.entries<any>(settings.features ?? {})) {
    const fields = entry.type === 'event' ? ['data'] : entry.type === 'method' ? ['input','output'] : [];
    if (entry.schema && (!fields.length || Object.keys(entry.schema).some(key => !fields.includes(key))))
      throw Error('Invalid schema for feature type');
    if (entry.type !== 'method' && ('priority' in entry || 'canEvict' in entry))
      throw Error('Only methods may declare queue priority');
    features.set(name, {
      ...entry,
      type: entry.type ?? 'doc',
      input: compileSchema(entry.schema?.input),
      output: compileSchema(entry.schema?.output),
      data: compileSchema(entry.schema?.data),
    });
  }
  const env = Object.fromEntries(Object.entries(settings.env ?? {}).map(([name,value]) =>
    [name, typeof value === 'string' ? value : value.secret]));
  const {features:contract,env:encoded,...runnerOptions} = settings;
  const runtime:RunnerSettings = {...runnerOptions,...(encoded && {env})};
  if (source.run.type === 'process') {
    if (!checkProcessSettings(settings)) throw Error('Invalid process manifest: ' + ajv.errorsText(checkProcessSettings.errors));
    if (!isAbsolute(settings.cwd)) throw Error('Inline manifest requires an absolute cwd');
    const args = settings.args ?? [];
    if ([settings.command, settings.cwd, ...args, ...Object.values(env)].some(value => value.includes('\0')))
      throw Error('NUL is not allowed in process settings');
    runtime.args = args;
  }
  return {features, settings:runtime,
    runnerType: source.run.type, mode, poolSize, maxLifetimeMs, idleTimeoutMs, maxRestarts:source.executors.maxRestarts ?? 0,
    subscriptions: compileSubscriptions(source.subscriptions ?? [])};
}
