# Permissions and membership

Each node stores its permissions. `null` leaves that level unrestricted. An empty array leaves the base sandbox filesystem and the node's private temporary directory. Each level on a path from the APP or USER to the workspace must permit an operation. Team membership adds another path. The APP's or USER's own permissions apply on every path. A fully trusted path allows a process to run outside the sandbox.

Read and replace rules with `$.node.permissions.get` and `$.node.permissions.set({permissions})`. Management methods and their arguments also undergo permission checks. Permission to manage another node's rules or membership can grant additional authority.

```json
[
  {"node":"./**","methods":{"reports.save":{"type":"object","required":["text"]}}},
  {"read":"/workspace/private","deny":true},
  {"read":"/workspace"}
]
```

`.` selects the rule owner, `@` the initiator of the check and `~` the workspace. `teamId/*`, `teamId/**` and `teamId/&` select direct children, all descendants and direct team members respectively. The first matching selector in a list wins, as in `["!archive",true]`. The `events` and `methods` fields support name patterns and JSON Schema validation. The `node` keyword in a schema validates a matching node ID.

`$.team.members.add({appId})` and `delete({appId})` change APP or USER membership. Read current members with `$.team.members.list({})`. From the APP or USER, use `$.app.memberships.add({teamId})`, `delete({teamId})` and `list({})`.

File `write` permits reading and writing. Denying `read` removes both. Denying `write` removes writing. Put narrow exceptions before broad rules. Paths may identify files or directories. Sandbox mount targets must exist at launch. The directory administrator must preserve the name, type and location of each mount point. A running process keeps its mounted paths and network mode for the lifetime of that process.

`network` enables process network access. The separate `http` permission allows incoming public HTTP requests. Binding an authorization PROFILE preserves the APP's effective permissions for its own work. Profile-defined MCP connections also require the relevant permissions of the selected PROFILE. See [Codex APPs](codex.md) and [webhook configuration](webhook.md).
