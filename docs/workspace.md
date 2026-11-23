# Workspace and APPs

The workspace is the root of the tree. TEAM nodes group nodes and define access boundaries. USER represents an account. APP represents an application with an address, permissions and subscriptions. For example, a Telegram bot integration and its chat agent can be separate APPs. The agent can receive permission to send messages while the integration retains the bot token.

- **Runner and mode.** Choose `process` for a script or `codex` for a Codex agent. A persistent executor suits a bot that holds an open connection. A one-shot executor handles an incoming event or call and then exits.
- **Permissions and subscriptions.** Permissions determine which operations are available. Subscriptions select events within those permissions. A subscription to incoming messages does not grant the right to send a reply.
- **Startup.** A new APP is stopped. After starting, `working` means it can accept work, even when no process has launched yet. A bot that needs to connect immediately can subscribe to its own transition to `working`.

Use `discover` to list visible nodes and `help` to inspect methods and events. The controller checks permissions when a method is called. See the [process runner contract](dev/runners/process.md) and [APP events and subscriptions](app-exchange.md).

### Browse a node's contract

`help({node})` returns an object keyed by feature name. It shows entries with no registered ancestor. Each entry has a `type` (method, event or document), a `version` and a short `description`. A feature with descendants also has `provides`, counting all descendant methods, events and documents in the node's catalog. Zero counts are omitted. Any feature may have children.

Pass `features: true` for the complete catalog, an exact name for one entry, or an array to combine selections. The pattern `chat.send.*` selects one level below the method and `chat.send.**` selects every level below it. A more detailed query could be:

```json
{"node":"APP_ID","features":["chat.send","chat.send.**"],"schema":true,"doc":true}
```

Available schemas and detailed documentation appear inside each selected entry. Method schemas use `input` and `output`, and event schemas use `data`. Set `description: false` for a compact index. An empty selection or an undiscoverable node returns `{}`. The selector and projection flags work the same through HTTP, WebSocket and executor requests.

## File permissions

Use absolute container paths in `read` and `write`. On Linux the controller checks each existing component when saving permissions. A symbolic link, including a dangling link, rejects the whole change. You can specify a missing name in advance. Create the files and directories needed for mounts before launching the executor. The runner checks mount points again at launch.

Keep the names and locations of hidden objects and individually mounted files or directories stable while the executor runs. A writable file can be modified in place. Inside an allowed directory the sandbox resolves ordinary symbolic links. [Process mounts and limits](dev/runners/process.md) · [File browser](user-files.md)
