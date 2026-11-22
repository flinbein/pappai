# Manage an APP

Sign in to the panel as an administrator and select an APP in the node list. Its card shows status, the last issue, occupied executor slots and queued calls. Refreshing the card preserves unsaved text in the editor.

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
