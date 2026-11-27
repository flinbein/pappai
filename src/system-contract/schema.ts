// These schemas describe the JSON values exchanged by system calls and events.
// Settings specific to a runner are checked against its registered settings schema.
export type Schema = Record<string, unknown> | boolean;
export const string = {type: 'string'};
export const boolean = {type: 'boolean'};
export const nil = {type: 'null'};
export const id = {type: 'string', minLength: 1};
export const nodeName = {type: 'string', pattern: '\\S', maxLength: 255};
export const count = {type: 'integer', minimum: 0};
export const runnerName = {type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$'};
export const httpName = {type: 'string', pattern: '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'};
export const status = {enum: ['working', 'stopped', 'stopping', 'error']};
export const nodeType = {enum: ['workspace', 'team', 'user', 'app', 'profile']};

export function object(properties: Record<string, Schema>, required = Object.keys(properties)) {
  return {type: 'object', properties, required, additionalProperties: false};
}

export function array(items: Schema) { return {type: 'array', items}; }
export function either(...anyOf: Schema[]) { return {anyOf}; }
export const empty = object({});
export const schemaValue = either(boolean, {type: 'object'});

const selector = either(boolean, {type: 'string', pattern: '^!?(?:@|(?:~|[A-Za-z0-9_-]+|\\.|\\.\\.(?:/\\.\\.)*)(?:/(?:\\*{1,2}|&))?)$'});
export const scope = array(selector);
const nodes = either(selector, scope);
const types = either(nodeType, array(nodeType));
const messageName = {type: 'string', pattern: '^(?:(?:[\\w$-]+|\\*)\\.)*(?:[\\w$-]+|\\*{1,2})$'};
const condition = either({const: '*'}, schemaValue);
const messages = either(boolean, messageName, array(messageName), {
  type: 'object', propertyNames: messageName, additionalProperties: either(condition, array(condition)),
});
const absolutePath = {type: 'string', pattern: '^/'};
const paths = either(boolean, absolutePath, array(absolutePath));
const rule = object({
  node: nodes, nodeType: types, methods: messages, cli: messages, events: messages,
  discover: boolean, delivery: boolean, checkPermissions: boolean, network: boolean, http: boolean, deny: boolean,
  read: paths, write: paths,
}, []);
export const permissions = either(nil, array(rule));

export const ruleId = {type: 'string', minLength: 1, maxLength: 255};
const subscriptionFields = {
  node: nodes, nodeType: types, caughtBy: nodes, events: messages, description: string,
  enabled: boolean, priority: {type: 'integer', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER},
  canEvict: boolean, deny: boolean,
};
export const subscriptions = {...array(object({id: ruleId, ...subscriptionFields}, ['id'])), maxItems: 512};
const manifestSubscriptions = {...array(object(subscriptionFields, [])), maxItems: 512};
const duration = {type: 'integer', minimum: 1, maximum: 2147483647};
const executorOptions = {
  poolSize: {type: 'integer', minimum: 1, maximum: 20}, maxLifetimeMs: duration,
  idleTimeoutMs: either(duration, nil), maxRestarts: {type: 'integer', minimum: 0, maximum: 10},
};
const mode = {enum: ['oneShot', 'persistent']};
export const manifest = object({
  run: object({type: runnerName, settings: {type: 'object', description: 'Settings and application features declared by this runner.'}}),
  executors: object({mode, ...executorOptions}, ['mode']),
  subscriptions: manifestSubscriptions,
}, ['run', 'executors']);
const environment = {
  type: 'object', additionalProperties: either(string, nil, object({secret: either(string, {const: true})})),
};
const override = object({
  run: object({settings: object({cwd: string, env: environment}, [])}, []),
  executors: object(executorOptions, []), subscriptions: manifestSubscriptions,
}, []);
export const source = either(object({manifest}), object({file: id, override}, ['file']));
