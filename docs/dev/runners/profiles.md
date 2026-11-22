# Runner profiles

The controller stores PROFILE nodes and checks whether an APP is in scope before allowing it to use a profile. A new PROFILE is disabled. Bind it using `profile` in `$.app.create` or `$.app.profile.set({profile})`. Inspect its state with `$.profile.get` and the APP's binding with `$.app.get`. [Codex setup example](../../codex.md)

## Profile contents

A PROFILE is a leaf in the workspace or TEAM tree with its own ID, name and state. It can hold independent connections for several installed runners. It has no queue or workers. Its system methods manage its lifecycle and `scope`. Ordinary method permits control who can create a profile in a TEAM or configure a particular connection. A USER working from the panel and an agent acting as its APP use the same methods.

An APP stores an optional profile ID in its own settings. The manifest selects the runner through `run.type`. Copying or updating the manifest preserves the existing profile binding. At launch the runner gets access to its own connection. Each worker's session history and working state are separate from the shared connection.

## Who can use a connection

A profile's `scope` defaults to `[]`. It selects APPs using the standard [selector rules](../../permissions.md). Access covers every connection in the profile, including ones added later. Create a separate PROFILE for connections with a different audience.

For example, `["!support-agents/**", "support/**"]` allows descendants of the TEAM with ID `support`, except descendants of `support-agents`. A list of two exact IDs allows two APPs from different TEAMs to use one personal profile. The controller checks the APP's own ID. The membership of the USER who created the APP or called its method does not carry over to the APP.

You can save `APP.profile` before adding the APP to `scope`. Before each launch, the controller verifies that the selected profile exists, is enabled and includes the APP in scope. A runner that needs credentials also checks its connection. Failure puts the APP in `error` without automatic retries or fallback to a host account.

The built-in `process` runner accepts an empty or omitted `profile`. With an explicit PROFILE, the same admission and revocation rules apply even though the runner needs no account to start a process.

## Worker permissions

For ordinary work the controller uses the APP's effective permissions. These govern file access, network access, calls to other nodes and other controller operations. Binding a PROFILE grants access to the selected connection when `scope` allows it. The APP remains the source of calls and events. Relative selectors are evaluated from the owner of the rule.

For example, an APP with write access to `/projects` can still write there when its PROFILE allows only reads under `/projects/team`. An APP with network access can connect to an APP-defined HTTP MCP server even when its PROFILE denies network access. An APP without network access does not acquire it by selecting a profile.

Profile-provided MCP servers have additional restrictions. A profile HTTP server requires both APP and PROFILE network permission. For a planned profile stdio server, only its subprocess will run with the intersection of the APP's and PROFILE's effective permissions. Each subject's rule ordering and membership grants are resolved independently. APP-defined MCP servers use the APP's permissions. [MCP connections and management operations](mcp.md)

## Changes in access

When reserving a launch, the controller records the actual profile, APP and worker IDs. Changes to `scope`, membership or a node's position in the tree trigger a fresh check of affected workers against the updated tree. A worker that loses access stops receiving assignments immediately and begins normal shutdown. The controller cancels a pending launch where possible. A process that has already started receives no first assignment after access is revoked.

| Situation | Result |
|---|---|
| The current persistent worker loses access | The APP immediately enters `error`. The usual error rules clear its queue. |
| A one-shot worker loses access | The worker shuts down normally. A one-shot or sleeping APP enters `error` on the first failed launch. An already queued call can trigger the failure as soon as a slot opens. |
| An old worker is finishing after its APP switched profiles | Revocation affects only workers actually using the revoked profile. The new worker and the APP's status are preserved. |

An accepted assignment can finish during graceful shutdown. If the worker exits without replying, the call fails. The controller does not requeue it because an external side effect may already have occurred.

Changing PROFILE permissions can change which shared HTTP MCP servers are available while the APP remains in scope. If the combined network decision changes, the controller retires workers that selected profile MCP servers so their next launch gets the new server list. A worker that uses only APP-defined servers can continue under its APP permissions.

Disabling a PROFILE revokes access to all its connections under the same rules. Enabling it restores access according to the current `scope`. Use the normal `start` command for an APP in `error`. To retire a profile, disable it, remove runner-specific credentials and unbind its APPs. Deleting the node and cleaning up all installed runners is planned.

## Setup through an installed runner

The runner declares methods under its registered name, such as `codex.setup`, `codex.status` and `codex.remove`. The controller lists the advertised methods in the PROFILE node's `help`. Consult the runner's documentation for their arguments. Calls go directly to the trusted runner host. A method permit is enough to invoke setup on a disabled profile with an empty `scope`, before an APP starts. `codex.remove` removes only the Codex connection.

Each connection has a private service directory, for example `$PAPPAI_PROFILES_DIR/{profileId}/{runnerName}/`. The runner defines the supported setup methods, validates the input and stores its connection files. A failed import preserves the previous working connection. Status can report a completed import and a successful access check separately. Responses and help omit secrets.

A USER or agent can import a file prepared in advance.

```json
{
  "node": "support-profile",
  "method": "codex.setup",
  "data": { "authFile": "/tmp/codex-auth.json" }
}
```

1. The controller checks the caller's method permit and validates the arguments. The runner receives `caller`, `callId` and the original data. The runner defines the meaning of `authFile`.
2. The runner sends `profileRead` with the call ID, read request ID and path. The controller verifies that the call is open and assigned to that host. It identifies the actual caller and, for an APP, the worker instance.
3. The controller opens a regular file in the caller's filesystem view using current permissions. On success, `profileFile` delivers up to 1 MiB to the trusted host. For a sandboxed `process` worker, `/tmp` resolves to its private directory. Isolated Codex workers use their own tmpfs, which the controller cannot read through this mechanism.
4. The runner validates the credentials and saves them atomically. Closing the call prevents further reads.

This interface needs neither a `fileInputs` declaration nor a duplicate path in `call.read`. The controller checks the requested access without interpreting arbitrary strings in `data`. A trusted runner can request another path within the caller's permissions. The method contract specifies which files it needs. Ordinary APPs use [call-scoped delegation](../../delegated-files.md) to exchange files.

See [installing the Codex CLI](codex.md) and [MCP permissions](mcp.md) for the external runner's contracts.
