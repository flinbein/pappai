import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const ajv = new Ajv2020({strict: true, addUsedSchema: false, ownProperties: true});
addFormats(ajv);
const validators = new Map<string, ValidateFunction>();
export type ResolveNodes = (selector: any, types?: any) => string[];
const maps = ['$defs','definitions','properties','patternProperties','dependentSchemas'];
const singles = ['not','if','then','else','items','contains','additionalProperties','propertyNames','unevaluatedItems','unevaluatedProperties','contentSchema'];

function standardSchema(value: any, resolve?: ResolveNodes): any {
  if (typeof value === 'boolean') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Expected JSON Schema');
  const schema = {...value};
  if (Object.hasOwn(schema,'$schema') && schema.$schema !== 'https://json-schema.org/draft/2020-12/schema')
    throw Error('Unsupported JSON Schema dialect');
  if ('$async' in schema) throw Error('Async schema not supported');
  for (const key of ['$ref','$dynamicRef']) if (key in schema &&
    (typeof schema[key] !== 'string' || !schema[key].startsWith('#'))) throw Error('Only local schema references are supported');
  for (const key of maps) if (schema[key]) {
    schema[key] = Object.fromEntries(Object.entries(schema[key]).map(([k,v]) => [k,standardSchema(v,resolve)]));
  }
  for (const key of singles) if (Object.hasOwn(schema,key)) schema[key] = standardSchema(schema[key],resolve);
  for (const key of ['allOf','oneOf','anyOf','prefixItems']) if (Array.isArray(schema[key]))
    schema[key] = schema[key].map((s:any) => standardSchema(s,resolve));
  if ('node' in schema || 'nodeType' in schema) {
    if (!resolve || !('node' in schema)) throw Error('Expected node selector in extended schema');
    const ids = resolve(schema.node,schema.nodeType);
    delete schema.node;
    delete schema.nodeType;
    schema.allOf = [...(schema.allOf ?? []), ids.length ? {enum:ids} : false];
  }
  return schema;
}

export function compilePolicySchema(schema: any, resolve?: ResolveNodes) {
  const standard = standardSchema(schema,resolve);
  const key = JSON.stringify(standard);
  let validator = validators.get(key);
  if (!validator) {
    validator = ajv.compile(standard);
    if (typeof standard === 'object') ajv.removeSchema(standard);
    if (validators.size >= 512) validators.delete(validators.keys().next().value!);
    validators.set(key,validator);
  }
  return validator;
}
