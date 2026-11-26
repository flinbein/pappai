import {document, event, method} from './feature.ts';
import {array, boolean, either, empty, httpName, id, nil, nodeName, object, permissions,
  runnerName, schemaValue, scope, source, string} from './schema.ts';

const created = object({id});
const child = {name: nodeName, permissions};

export const workspace = {
  '$.workspace': document('Workspace startup.', 'Subscribe on ~ for the controller startup event. Use discover to inspect the current tree when connecting to a running workspace.'),
  '$.workspace.init': event('Workspace initialization completed.', 'The controller publishes this event from ~ after initializing its runners and restoring manifest sources. Existing subscribers can use it to resume work.', empty),
};

export const children = {
  '$.children': document('Create direct children of this workspace or team.', 'Call the appropriate create method on the parent. Each method requires its own permit on that parent and checks its arguments. A successful call returns the new ID. Subscribe to $.node.created on the children to observe creation.'),
  '$.children.createTeam': method('Create a working team under this parent.',
    'Send {"name":"Operations"} for the delegation template. It grants operation, CLI, event, delivery and discovery access on descendants and the four child creation methods on the team itself. To grant a directory, supply the desired ordered rules with a file rule. The template grants no network access. An explicit [] leaves the team without additional grants. Pass null to leave this level unrestricted. The permit on the parent is checked against the effective initial rules.',
    object(child, ['name']), created),
  '$.children.createUser': method('Create a stopped user account under this parent.',
    'Supply a display name and a unique email address. For example, {"name":"Jo","email":"jo@example.org"}. Omitted permissions default to []. Start the account with $.lifecycle.start to allow sign-in.',
    object({...child, email: string}, ['name', 'email']), created),
  '$.children.createApp': method('Create a stopped APP with a manifest source.',
    'Supply a display name and source. Pass {"file":"/workspace/jobs/manifest.json"} as source to use a file the APP can read. Alternatively supply {"manifest":...} with a complete inline manifest. The controller validates the manifest, runner and optional profile or HTTP name before returning the APP ID. Omitted permissions default to [].',
    object({...child, source, profile: either(id, nil), httpName: either(httpName, nil)}, ['name', 'source']), created),
  '$.children.createProfile': method('Create a stopped authorization profile.',
    'Supply a name and optionally an ordered scope array and permissions. For example, {"name":"Build login","scope":["build-team/&"]}. Both lists default to []. Configure its runner connection on the new PROFILE. Start the profile to allow matching APPs to use it.',
    object({...child, scope}, ['name']), created),
};

const registration = object({
  name: runnerName, entrypoint: either(string, nil), previousEntrypoint: either(string, nil),
  enabled: boolean, available: boolean, settingsSchema: schemaValue,
  source: object({type: {enum: ['git', 'npm']}, spec: string, ref: string}, ['type', 'spec']),
}, ['name', 'entrypoint', 'previousEntrypoint', 'enabled', 'available']);
const installation = object({name: runnerName});
export const runners = {
  '$.runners': document('Manage workspace runner registrations and hosts.', 'Call these methods on ~ as a workspace administrator with the corresponding method permit. Prepare the installation and its entrypoint before registering or switching releases. Hosts execute with controller authority. List installations to see which hosts are available.', '2'),
  '$.runners.list': method('List registered runners and their current availability.', 'Returns an array sorted by installation name. Enabled is the saved setting. Available indicates a ready host accepting work. A prepared release may also identify its source and the runner may publish a settings schema.', empty, array(registration)),
  '$.runners.add': method('Register an installation and start its host.', 'Supply a unique name and an absolute entrypoint inside its prepared installation directory. The controller waits for the new host to declare readiness before saving its registration. A bad entrypoint, duplicate name or failed startup rejects the call.', object({name: runnerName, entrypoint: id}), empty),
  '$.runners.enable': method('Enable an installed runner and start its host.', 'Supply the registered name. A ready host accepts work after the call completes. Enabling a host that is already running succeeds.', installation, empty),
  '$.runners.disable': method('Stop a runner host and disable automatic startup.', 'Supply the registered name. Disabling interrupts execution on this host and retains its registration for a later enable.', installation, empty),
  '$.runners.restart': method('Restart a runner, optionally activating a prepared entrypoint.', 'Supply the registered name. To switch releases, also supply an absolute entrypoint in that installation. When activation fails after switching an enabled host, the controller attempts to restore its previous host. Overlapping operations on the installation can fail.', object({name: runnerName, entrypoint: id}, ['name']), empty),
  '$.runners.delete': method('Remove a runner and its managed installation directory.', 'Supply the registered name. This stops the host, deletes its registration and removes its managed installation files. The built-in process runner cannot be removed.', installation, empty),
};
