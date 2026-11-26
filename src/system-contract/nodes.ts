import {document, event, method} from './feature.ts';
import {array, empty, id, nil, object, permissions as rules, scope, status, string} from './schema.ts';

export const node = {
  '$.node': document('Read node identity and observe creation.', 'Use $.node.get to identify the node and its structural parent. Subscribe to $.node.created to observe new children. On APP, USER and PROFILE the summary includes the same status returned by $.lifecycle.get.', '2'),
  '$.node.get': method('Read the ID, type, name, parent ID and status.', 'Call with {}. The parentId identifies the structural parent. For a direct child of the workspace its value is "~". Memberships are available separately through $.memberships.list.', empty,
    object({id, type: {enum: ['team', 'app', 'user', 'profile']}, name: string, parentId: id, status})),
  '$.node.created': event('This node was created.', 'The new node publishes its initial status after successful creation. Read its identity with $.node.get. A new TEAM starts working. A new USER, APP or PROFILE starts stopped.', object({status})),
};

export const lifecycle = {
  '$.lifecycle': document('Manage availability of an APP, USER or PROFILE.', 'Read get for the current status and subscribe to statusChanged for transitions. A working APP accepts work, a working USER can sign in, and a working PROFILE can supply credentials to APPs matching its scope. Only an APP can restart its execution via $.app.restart.'),
  '$.lifecycle.get': method('Read the current lifecycle status.', 'Returns {"status":"working"}, {"status":"stopped"}, {"status":"stopping"} or {"status":"error"}. An APP can be working without an active executor. Use $.app.executors.get for process counts.', empty, object({status})),
  '$.lifecycle.start': method('Allow execution, sign-in or use of a profile.', 'Call with {}. An APP begins accepting work after its runner and manifest checks succeed. A stopping APP must finish stopping first. A USER can sign in again with a registered passkey. A PROFILE can supply its saved credentials to new executors in scope. Starting a working node succeeds.', empty, empty),
  '$.lifecycle.stop': method('Stop execution, sign-in or use of a profile.', 'An APP rejects new work, clears its queue and retires executors. The call may return while status is stopping. Watch statusChanged for stopped or error. Stopping a USER revokes web sessions and closes all of its terminals, including CLI and shared tabs. Passkeys remain registered. Stopping a PROFILE revokes its use by active executors and retains its credentials.', empty, empty),
  '$.lifecycle.statusChanged': event('This node changed lifecycle status.', 'The node publishes the prior and current status after a transition. For example, {"previousStatus":"working","status":"stopping"}. Read $.lifecycle.get for the latest value after reconnecting.', object({previousStatus: status, status})),
};

const permissionsValue = object({permissions: rules});
export const permissions = {
  '$.permissions': document('Read and replace this node’s stored permission rules.', 'Rules are evaluated in order at each level of a permission path. A node can have paths through its structural parent and through team memberships. Its own rules apply on every path. Use $.effectivePermissions.invalidated on APP, USER or PROFILE to know when a prior decision may need checking.'),
  '$.permissions.get': method('Read the rules stored on this node.', 'Returns {"permissions":null} for an unrestricted level or an ordered array in permissions. An empty array grants no additional capabilities. Parent rules and memberships participate when the controller checks a particular action.', empty, permissionsValue),
  '$.permissions.set': method('Replace all permission rules stored on this node.', 'Supply {"permissions":[...]} or {"permissions":null}. Selectors are relative to the rule owner. For example, {"permissions":[{"node":"./**","discover":true}]} allows discovering descendants at this level. The controller checks the rule syntax and rejects invalid selectors. A successful change emits $.permissions.changed.', permissionsValue, empty),
  '$.permissions.changed': event('The stored permission rules changed.', 'The node publishes an empty payload after committing different rules. Rule order matters. Authorized readers can call $.permissions.get for the current list.', empty),
};

export const effectivePermissions = {
  '$.effectivePermissions': document('Observe changes that can affect access checks.', 'Permissions depend on rules, tree position, memberships and selectors. Subscribe on the APP, USER or PROFILE whose access you follow. After reconnecting, refresh the state visible to the caller.'),
  '$.effectivePermissions.invalidated': event('A previous access decision may have changed.', 'The affected node publishes {}. Repeat the relevant permission-dependent operation or refresh discover. Other paths may still grant the same operation. The payload discloses no rules or team IDs.', empty),
};

const member = object({memberId: id});
export const team = {
  '$.team': document('Manage explicit membership of this team.', 'Use the members service to add, remove and inspect direct members. Create a structural child through $.children. A member can belong to multiple teams.', '2'),
  '$.team.members': document('List, add or remove direct members.', 'Call these methods on the receiving TEAM. An APP, USER or PROFILE can be a member. Membership adds a permission path and can cause selectors such as TEAM_ID/& to match. Grant membership management carefully when other rules trust the team.'),
  '$.team.members.list': method('List direct member IDs.', 'Call with {} to obtain an array of APP, USER and PROFILE IDs in ID order. Structural children are included only if explicitly added as members.', empty, array(id)),
  '$.team.members.add': method('Add an APP, USER or PROFILE to the team.', 'Supply {"memberId":"NODE_ID"} on the receiving TEAM. The caller needs the method permit for these arguments. Repeating an existing membership succeeds. Membership can change access through other nodes’ selectors.', member, empty, '2'),
  '$.team.members.remove': method('Remove an explicit member from the team.', 'Supply {"memberId":"NODE_ID"} on the receiving TEAM. Removing an absent membership for an existing eligible node succeeds. The node and its structural parent are preserved.', member, empty),
};
export const memberships = {
  '$.memberships': document('Inspect the teams this node explicitly belongs to.', 'Memberships are separate from the structural parent in $.node.get. To change membership, call $.team.members.add or $.team.members.remove on the receiving TEAM with this node’s memberId.'),
  '$.memberships.list': method('List IDs of teams this node explicitly belongs to.', 'Call with {}. The result is an array of team IDs in ID order. A new node without explicit memberships returns [].', empty, array(id)),
};

export const user = {
  '$.user': document('Manage user account recovery.', 'Use recovery to request registration of a new passkey. Manage sign-in availability with $.lifecycle. The USER’s sessions and its registered passkeys have separate lifetimes.', '2'),
  '$.user.recovery': document('Request an emailed passkey registration code.', 'Call send on the USER whose email should receive the code. The registration ceremony separately checks the $.user.passkeys.create permission. Complete registration in the web interface.'),
  '$.user.recovery.send': method('Send a one-time registration code to the user’s email.', 'Call with {}. A successful call completes after the mail transport accepts the message. The code expires after ten minutes. A permission check, rate limit or delivery failure can reject the request.', empty, nil),
};
export const profile = {
  '$.profile': document('Control which APPs may use this authorization profile.', 'Use scope to select consumers and $.lifecycle to enable or disable this PROFILE. Configure an installed runner’s credentials using the features it publishes on the PROFILE.', '2'),
  '$.profile.scope': document('Select APPs eligible to use this profile.', 'Selectors are evaluated from this PROFILE against the consuming APP. An empty scope denies use. An APP also needs to select this profile and the profile must be working.'),
  '$.profile.scope.get': method('Read the ordered scope selectors.', 'Returns {"scope":[...]}. For example, ["team-id/&"] selects explicit members of that team. Use $.lifecycle.get to check whether the profile is working.', empty, object({scope})),
  '$.profile.scope.set': method('Replace the profile’s scope and recheck its use.', 'Supply the complete ordered selector array, for example {"scope":["team-id/&"]}. To revoke use by every APP, pass {"scope":[]}. The controller rechecks active executors and revokes use when an APP falls outside scope.', object({scope}), empty),
};
