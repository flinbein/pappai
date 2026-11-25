# Manage an APP

Sign in and select a node in the sidebar tree. Expand or collapse branches using the arrows. The sidebar also contains account controls and links to files, the terminal and the RPC console. On a wide screen, the selected node appears next to the sidebar. Selecting a method or another action opens a third column. On a phone, tap a breadcrumb to switch the visible pane while keeping the current URL and selection.

The node pane shows the node's type and stable ID. Under **Methods and help**, select a method to inspect its version and schema, enter JSON arguments and invoke it. You can bookmark its address at `/nodes/<id>/methods/<name>`. Opening the link displays the form. The controller checks your permissions when you submit it. For complete RPC parameters, open **RPC console** at `/rpc`.

To create a child, select a workspace or TEAM and choose the creation action for the desired kind. Available kinds include TEAM, USER, PROFILE, a persistent Codex APP and an APP with a custom manifest source. Each form has its own address, such as `/nodes/~/create/team` for a TEAM under the workspace. The panel selects the new node if you can see it. [Create and configure a Codex agent](codex.md#from-the-web-panel)

For administrators, **Manage APP** shows status, the last issue, occupied executor slots and queued calls. Refreshing the APP state preserves unsaved text in the manifest editor.

Stopping the APP closes admission and fails queued calls immediately. An active process receives SIGINT and can still send a reply. After ten seconds the runner sends SIGKILL to any remaining process. The APP stays in `stopping` while termination is pending. Start it again to accept work. The first assignment launches a process.

To change the command, arguments or contract, edit the JSON manifest source and save it. Use `{"manifest":{…}}` for an inline source or `{"file":"/absolute/path","override":{…}}` for a file. A validation error preserves the previous source. A persistent process keeps its settings and contract until it exits. Restart it to apply the change while keeping its queue. One-shot pools adopt the new contract immediately. Workers already running finish the work they accepted. [File manifests and webhooks](webhook.md)

Use `call` with permission for the corresponding method.

| Method | Arguments in `data` | Result |
|---|---|---|
| `$.app.get` | `{}` | `status`, `lastIssue`, `manifestChanged`. The last field indicates whether the most recently validated configuration differs from the applied one. |
| `$.app.executors.get` | `{}` | `mode`, `active`, `limit`, `queued`, `restarting`. Work that occupies a slot is already excluded from `queued`. |
| `$.app.stop`, `$.app.start`, `$.app.restart` | `{}` | `{}` when accepted. Check the result with `$.app.get` and `$.app.executors.get`. |
| `$.app.manifest.get` | `{}` | The source as `{manifest}` or `{file,override?}`, with secrets masked. |
| `$.app.manifest.getApplied` | `{}` | The applied manifest after overrides, with secrets masked. |
| `$.app.manifest.set` | `{source}` | `{}` after validating and saving the complete source. |

[Create an APP and call it](first-call.md) · [Execution and contracts](dev/architecture-review.md)
