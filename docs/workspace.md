# Workspace and APPs

The workspace is the root of the tree. TEAM nodes group nodes and define access boundaries. USER represents an account. A PROFILE holds runner connections for the APPs in its scope. An APP has an address, permissions and subscriptions. For example, a Telegram bot integration and its chat agent can be separate APPs. The agent can receive permission to send messages while the integration retains the bot token.

- **Runner and mode.** Choose `process` for a script or `codex` for a Codex agent. A persistent executor suits a bot that holds an open connection. A one-shot executor handles an incoming event or call and then exits.
- **Permissions and subscriptions.** Permissions determine which operations are available. Subscriptions select events within those permissions. A subscription to incoming messages does not grant the right to send a reply.
- **Startup.** A new APP is stopped. After starting, `working` means it can accept work, even when no process has launched yet. A bot that needs to connect immediately can subscribe to its own transition to `working`.

Use `discover` to list visible nodes and `help` to inspect methods and events. The controller checks permissions when a method is called. See the [process runner contract](dev/runners/process.md) and [APP events and subscriptions](app-exchange.md).

### Browse a node's contract

`help({node})` returns an object keyed by feature name. It shows entries with no registered ancestor. Each entry has a type (`method`, `event`, `cli` or `document`), a version and a short description. A feature with descendants also has `provides`, counting descendants by type. Zero counts are omitted. Any feature may have children.

System services appear as documents whose names begin with `$.`. Each node of a supported type implements the whole service. If an agent knows the name and version of a system service from one node, it can use that same interface on another node advertising the same pair. The caller still needs permission for the operation and its arguments.

| Target | System services shown in HELP | Additional features |
|---|---|---|
| WORKSPACE (`~`) | `$.workspace`, `$.children`, `$.runners` | Installed runners can publish administrative methods under `runners.<name>` |
| TEAM | `$.node`, `$.permissions`, `$.children`, `$.team` | |
| USER | `$.node`, `$.lifecycle`, `$.permissions`, `$.effectivePermissions`, `$.memberships`, `$.user` | |
| APP | `$.node`, `$.lifecycle`, `$.permissions`, `$.effectivePermissions`, `$.memberships`, `$.subscriptions`, `$.app` | Methods, events and documents in the applied manifest |
| PROFILE | `$.node`, `$.lifecycle`, `$.permissions`, `$.effectivePermissions`, `$.memberships`, `$.profile` | Installed runners can publish connection methods and interactive CLI features |

Pass `features: true` for the complete catalog, an exact name for one entry or an array to combine selections. A trailing `.*` selects one level and `.**` selects every level below the named group. For example, request the manifest manual, its methods and the event together.

```json
{"node":"APP_ID","features":["$.app.manifest","$.app.manifest.**"],"schema":true,"doc":true}
```

Method schemas use `input` and `output`, event schemas use `data` and CLI features can specify `input`. Read a document through `help`, invoke a method through `call`, subscribe to an event or launch a CLI through the terminal. Set `description: false` for a compact index. An empty selection or an undiscoverable node returns `{}`. These options work through HTTP, WebSocket and executor requests.

## Start and stop nodes

Call `$.lifecycle.get({})` on an APP, USER or PROFILE for its current status. Use `$.lifecycle.start({})` and `$.lifecycle.stop({})` on that same node. A successful command returns `{}`. The node publishes `$.lifecycle.statusChanged` with `previousStatus` and `status` when it changes state.

| Target | Stop | Start |
|---|---|---|
| APP | Clear pending work and retire executors. Status can remain `stopping` until the last process exits. | Accept new work. A stopping APP must finish its transition first. Runner or manifest errors can prevent startup. |
| USER | Revoke web sessions and close terminals, including shared tabs and CLI sessions. Registered passkeys survive. | Allow a new sign-in. The user opens a new session and new terminals. |
| PROFILE | Revoke the use of credentials by executors and retain the saved connection. | Allow new executors from APPs matching the current scope. |

The common `$.node.get({})` summary includes `id`, `type`, `name`, `parentId` and `status`. The newly created child publishes `$.node.created` with its initial status. TEAM starts in `working`. APP, USER and PROFILE start in `stopped`. See [APP restart and recovery](manage-app.md).

## File permissions

Use absolute container paths in `read` and `write`. On Linux the controller checks each existing component when saving permissions. A symbolic link, including a dangling link, rejects the whole change. You can specify a missing name in advance. Create the files and directories needed for mounts before launching the executor. The runner checks mount points again at launch.

Keep the names and locations of hidden objects and individually mounted files or directories stable while the executor runs. A writable file can be modified in place. Inside an allowed directory the sandbox resolves ordinary symbolic links. [Process mounts and limits](dev/runners/process.md) · [File browser](user-files.md)
