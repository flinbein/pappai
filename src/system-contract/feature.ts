import {compilePolicySchema} from '../policy-schema.ts';
import type {Schema} from './schema.ts';

export type Feature = {
  type: string;
  description: string;
  version: string;
  doc?: string;
  schema?: {input?: Schema; output?: Schema; data?: Schema};
  input?: ReturnType<typeof compilePolicySchema>;
  output?: ReturnType<typeof compilePolicySchema>;
  data?: ReturnType<typeof compilePolicySchema>;
};

export function document(description: string, doc: string, version = '1'): Feature {
  return {type: 'document', version, description, doc};
}

export function method(description: string, doc: string, input: Schema, output: Schema, version = '1'): Feature {
  return {type: 'method', version, description, doc, schema: {input, output},
    input: compilePolicySchema(input), output: compilePolicySchema(output)};
}

export function event(description: string, doc: string, data: Schema): Feature {
  return {type: 'event', version: '1', description, doc, schema: {data}, data: compilePolicySchema(data)};
}
