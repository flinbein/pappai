import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { isAbsolute } from 'node:path';

const ajv = new Ajv2020({ strict: true, addUsedSchema: false, ownProperties: true });
addFormats(ajv);

const schemaSlot = { anyOf: [{ type: 'object' }, { type: 'boolean' }] };
const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['run', 'executors'],
  properties: {
    subscriptions: { type: 'array', maxItems: 0 },
    executors: {
      type: 'object',
      additionalProperties: false,
      required: ['mode'],
      properties: {
        mode: { const: 'oneShot' },
        poolSize: { const: 1 },
        maxLifetimeMs: { type: 'integer', minimum: 1, maximum: 2147483647 },
      },
    },
    run: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'settings'],
      properties: {
        type: { const: 'process' },
        settings: {
          type: 'object',
          additionalProperties: false,
          required: ['command', 'cwd', 'features'],
          properties: {
            command: { type: 'string', minLength: 1 },
            cwd: { type: 'string', minLength: 1 },
            args: { type: 'array', items: { type: 'string' } },
            features: {
              type: 'object',
              maxProperties: 512,
              propertyNames: { pattern: '^[A-Za-z0-9_-]+(\\.[A-Za-z0-9_-]+)*$' },
              additionalProperties: {
                type: 'object',
                required: ['description', 'version'],
                additionalProperties: false,
                properties: {
                  type: { enum: ['doc', 'method'] },
                  description: { type: 'string', maxLength: 255 },
                  version: { type: 'string', minLength: 1 },
                  doc: { type: 'string' },
                  schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: { input: schemaSlot, output: schemaSlot },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};
type ProcessManifest = {
  run: { settings: { command: string; cwd: string; args?: string[]; features: Record<string, any> } };
  executors: { maxLifetimeMs?: number };
};
const validate = ajv.compile<ProcessManifest>(schema);

// Only schema-valued positions are visited. A property named "$ref" in const data is literal.
function checkReferences(value: any) {
  if (typeof value !== 'object' || value === null) return;
  if (Object.hasOwn(value, '$async')) throw Error('Async validation is not supported');
  for (const key of ['$ref', '$dynamicRef']) {
    if (typeof value[key] === 'string' && !value[key].startsWith('#'))
      throw Error('Only local schema references are supported');
  }
  for (const key of [
    'additionalProperties',
    'contains',
    'items',
    'not',
    'if',
    'then',
    'else',
    'propertyNames',
    'unevaluatedItems',
    'unevaluatedProperties',
  ]) {
    if (Object.hasOwn(value, key)) checkReferences(value[key]);
  }
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    if (Array.isArray(value[key])) value[key].forEach(checkReferences);
  }
  for (const key of ['$defs', 'definitions', 'dependentSchemas', 'properties', 'patternProperties']) {
    if (value[key]) Object.values(value[key]).forEach(checkReferences);
  }
}
function compile(value: any) {
  if (value === undefined) return undefined;
  checkReferences(value);
  return ajv.compile(value);
}
export function prepare(source: any) {
  if (!validate(source)) throw Error('Invalid inline manifest: ' + ajv.errorsText(validate.errors));
  const { settings } = source.run;
  if (!isAbsolute(settings.cwd)) throw Error('Inline manifest requires an absolute cwd');
  const features = new Map<
    string,
    {
      description: string;
      version: string;
      type: string;
      doc?: string;
      schema?: any;
      input?: ReturnType<typeof compile>;
      output?: ReturnType<typeof compile>;
    }
  >();
  for (const [name, entry] of Object.entries<any>(settings.features)) {
    if (entry.schema && entry.type !== 'method') throw Error('Only methods may declare schemas');
    features.set(name, {
      ...entry,
      type: entry.type ?? 'doc',
      input: compile(entry.schema?.input),
      output: compile(entry.schema?.output),
    });
  }
  const { command, cwd, args = [] } = settings;
  return { features, settings: { command, cwd, args }, maxLifetimeMs: source.executors.maxLifetimeMs };
}
