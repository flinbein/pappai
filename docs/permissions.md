# Permissions and membership

Each node stores its permissions. `null` leaves that level unrestricted. An empty array leaves the base sandbox filesystem and the node's private temporary directory. Each level on a path from the APP or USER to the workspace must permit an operation. Team membership adds another path. The APP's or USER's own permissions apply on every path. A fully trusted path allows a process to run outside the sandbox.

Read and replace rules with `$.permissions.get` and `$.permissions.set({permissions})`. Management methods and their arguments also undergo permission checks. Permission to manage another node's rules or membership can grant additional authority.

```json
[
  {"node":"./**","methods":{"reports.save":{"type":"object","required":["text"]}}},
  {"read":"/workspace/private","deny":true},
  {"read":"/workspace"}
]
```

`.` selects the rule owner, `@` the initiator of the check and `~` the workspace. `teamId/*`, `teamId/**` and `teamId/&` select direct children, all descendants and direct team members respectively. The first matching selector in a list wins, as in `["!archive",true]`. The `events` and `methods` fields support name patterns and JSON Schema validation. The `node` keyword in a schema validates a matching node ID.

## Delegate a team branch

Call `$.children.createTeam`, `createUser`, `createApp` or `createProfile` on the parent WORKSPACE or TEAM. Each method requires its own permit. A caller with permission to create a PROFILE can be restricted to that operation. Other rights of the caller, including its personal filesystem restrictions, do not automatically become the child's rules.

When `permissions` is omitted, a new TEAM receives these two rules. Selectors refer to the new TEAM after creation. A parent permit that restricts the creation arguments checks these effective rules.

```json
[
  {"node":"./**","methods":true,"cli":true,"events":true,"delivery":true,"discover":true},
  {"node":".","methods":["$.children.createTeam","$.children.createUser","$.children.createApp","$.children.createProfile"]}
]
```

To allocate a directory, append a file rule such as `{"write":"/workspace/operations"}` and submit the full list. File and network grants are optional. An explicit `[]` grants no additional rights. The panel's **No restrictions** button sets `permissions` to `null`. Creating an unrestricted TEAM and APP directly below it can give the APP an unrestricted path to the workspace. Check which APPs and users can modify nodes in that branch.

## Manage membership

On the receiving TEAM, call `$.team.members.add({"memberId":"NODE_ID"})` or `$.team.members.remove({"memberId":"NODE_ID"})` for an APP, USER or PROFILE. Both require permission for the operation and member ID. Grant a constrained argument schema if a moderator should manage only certain members. Adding an existing member or removing an eligible node that is already absent succeeds. The structural parent stays the same.

`$.team.members.list({})` returns the team's explicit member IDs. On an APP, USER or PROFILE, `$.memberships.list({})` returns the IDs of its teams. Removing membership can affect its own permission paths and grants elsewhere that select `TEAM_ID/&`.

## Observe changes

Subscribe to `$.permissions.changed` on the node whose stored rules you monitor. It sends `{}` after a change, including a change of rule order. A repeated write of the same rules is silent. An APP, USER or PROFILE can also publish `$.effectivePermissions.invalidated` with `{}` when a previous decision needs rechecking. Another permission path may still allow the operation. Refresh the relevant view or repeat the check. After reconnecting, fetch current state.

## Files, network and CLI

File `write` permits reading and writing. Denying `read` removes both. Denying `write` removes writing. Put narrow exceptions before broad rules. Paths may identify files or directories. Sandbox mount targets must exist at launch. The directory administrator must preserve the name, type and location of each mount point. A running process keeps its mounted paths and network mode for the lifetime of that process.

`network` enables process network access. The separate `http` permission allows incoming public HTTP requests. Binding an authorization PROFILE preserves the APP's effective permissions for its own work. Profile-defined MCP connections also require the relevant permissions of the selected PROFILE. See [Codex APPs](codex.md) and [webhook configuration](webhook.md).

Use `cli` to allow a USER to launch an interactive feature on a matching node. It supports the same name selectors, input schemas and ordered deny rules as `methods`. Calls made by the interactive program undergo their own method checks. For example, the following grants device login on one PROFILE. Include a discover rule if the user needs to find the PROFILE in the panel.

```json
[
  {"node":"PROFILE_ID","discover":true,"cli":"codex.authorize","methods":["codex.setup","codex.status"]},
  {"network":true}
]
```
