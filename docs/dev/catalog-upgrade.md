# Upgrading stored node service contracts

The service catalog changes RPC and event names in existing installations. SQLite retains the original permissions, personal subscriptions, applied manifests and manifest sources. The controller starts normally with these records. Before deploying, run the advisory inventory from the new controller checkout with its dependencies installed. Supply the workspace database path or a consistent SQLite backup.

```sh
node src/catalog-upgrade.ts /path/to/pappai.sqlite
```

The command opens one read-only snapshot and prints JSON with node IDs, rule positions, allow/deny/subscription effects and matching system names. It checks exact names, wildcard selectors and method/event keys in argument-schema filters. It includes disabled subscriptions for the next time they are enabled. A finding identifies a rule for review. Its effective reach depends on the ordered rules, node selectors, parent teams and memberships.

## Updating permissions

| Previous contract | Current contract |
|---|---|
| `$.team.create`, `$.user.create`, `$.app.create`, `$.profile.create` | `$.children.createTeam`, `createUser`, `createApp`, `createProfile` on the parent |
| `$.app.start`, `$.app.stop`, `$.profile.enable`, `$.profile.disable` | `$.lifecycle.start` and `$.lifecycle.stop` on APP, USER and PROFILE |
| `$.app.start({force:true})` | Separate APP-only `$.app.forceStart` permission |
| Status in `$.app.get` and `$.profile.get` | `$.lifecycle.get` or `$.node.get`. Read PROFILE scope with `$.profile.scope.get` |
| `$.node.permissions.get/set` | `$.permissions.get/set` |
| `$.team.members.add/delete({appId})` | `$.team.members.add/remove({memberId})` on the TEAM |
| `$.app.memberships.list` | `$.memberships.list` on the member |
| `$.app.memberships.add/delete` | Removed. Authorize writes on a specified TEAM and constrain `memberId` when delegating |
| `$.node.subscriptions.*` | `$.subscriptions.*`, with `remove` for the former `delete` |
| `$.runners.get` | `$.runners.list` |

Review both positive and negative rules. A first-match deny for `$.app.**` followed by a broad allow can expose the renamed lifecycle operations. Preserve the deny's position and applicable target types. An old grant for `$.app.start` could start APPs and USERs. An unrestricted rewrite to `$.lifecycle.start` would also enable PROFILEs. Choose the intended node types explicitly. Review payload schemas as well, including argument constraints on `force`, `appId` and former self-membership writes.

TEAM and USER creation now use the method permit on the parent. Rules such as `methods:true` can delegate creation where an additional administrator check previously applied. A new TEAM created with omitted permissions receives the branch-management template. An explicit list or `null` retains its meaning. Review creation constraints against the actual initial permissions.

## Updating event consumers

| Previous event | Current event |
|---|---|
| `$.app.statusChanged` | `$.lifecycle.statusChanged` on APP, USER and PROFILE |
| `$.node.lastIssueUpdated` | `$.app.lastIssueChanged` |
| `$.app.executor.failed` | `$.app.executors.failed` |
| `$.node.permissions.updated` | `$.permissions.changed` |
| `$.node.subscriptions.updated` | `$.subscriptions.changed` |

The new `$.effectivePermissions.invalidated` event can match broad event permits or subscriptions. Review each matching rule's source selector and payload schema. A write that preserves stored permissions or subscriptions produces no change event.

The report covers APP personal subscriptions, the applied manifest and the saved inline manifest or file override. An entry marked `source.file` identifies a publisher file for separate inspection. Read the saved source for that APP, check the publisher's manifest and update any override. An explicit `override.subscriptions` replaces the file's list. Check running code, external clients and browser subscriptions for references to old names, including scripts that construct calls at runtime. The inventory reads database rule selectors only.

Exercise representative allowed and denied calls and verify delivery from an event source with its actual subscriber before rolling out the updated configuration. [Backing up and restoring the workspace](restore.md)
