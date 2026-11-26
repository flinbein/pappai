# Run a Codex APP

As an administrator, open **Add runner** on the workspace, select **npm** and install `@flinbein/pappai-runner-codex` as `codex`. The first launch installs the native Codex CLI. Check its progress through the workspace method `runners.codex.getVersion`. Mount a persistent volume at `/run/pappai/private` for installed code, profile credentials and runner state. [Installation and updates](dev/runners/install.md)

## From the web panel

1. Open **Runners**. If `codex` is already available, continue to the tree. Otherwise choose **Add runner**, check the installed entrypoint and native CLI paths, and register it. Registration starts the installed runner.
2. Select the workspace in the tree. Choose **Create TEAM** and give the team a name. The panel selects the new team. Choose **Create PROFILE** inside it.
3. On the PROFILE, open **Profile settings**, enter the server-side path of your prepared Codex `auth.json` and choose **Import Codex credentials**. The controller resolves the path using your signed-in user's filesystem permissions.
4. Select the TEAM again and create **APP · Codex**. Choose the PROFILE you created. This template declares a persistent agent with message, history and interrupt methods. The permissions editor defaults to `[]`. Grant workspace permissions separately when the agent needs tools.
5. Return to the PROFILE and open its settings. Choose the new APP in the scope dropdown, save the scope, then enable the profile. The dropdown appends the selected ID to the rules shown in the editor.
6. Select the APP. Under **Manage APP**, choose **Start**. Open **Message agent** to send a message and read the reply. To read earlier messages, select `agent.getHistory` under **Methods and help** and call it with `{}`.

## Equivalent method calls

| Target | Method | Arguments |
|---|---|---|
| Workspace or TEAM | `$.profile.create` | `{"name":"shared","permissions":null}` |
| New PROFILE | `codex.setup` | `{"authFile":"/tmp/codex-auth.json"}` |
| Workspace or TEAM | `$.app.create` | Supply the name, APP permissions, profile ID in `profile` and manifest in `source.manifest`. |
| PROFILE | `$.profile.scope.set` | `{"scope":["APP_ID"]}` using the new APP's ID |
| PROFILE | `$.profile.enable` | `{}` |
| APP | `$.app.start` | `{}` |
| APP | `agent.execute` | `{"input":"Summarize the following text …"}` |

`codex.setup` reads the file using the caller's file permissions. For a sandboxed USER, `/tmp` is their private temporary directory. Check the import with `codex.status({})`. To revoke access, disable the profile with `$.profile.disable`, then remove the connection with `codex.remove`. To recover an APP after access was denied, restore authorization and scope, enable the profile and call `$.app.start`.

The [example manifests](https://github.com/flinbein/pappai-runner-codex/tree/master/examples) declare `agent.execute`. A one-shot executor returns the result of one task. A persistent executor preserves conversation history across launches. The controller checks the caller, method permission and declared schema.

The PROFILE selects the authorization the APP can use. The APP's effective permissions govern its own files, network tools and pappai calls. For example, two APPs can share one model login while writing to different directories. An HTTP MCP configured by the APP requires APP network access. An HTTP MCP selected from the PROFILE requires network access for both the APP and the PROFILE. Model access is independent of tool network access. See [profile scope and revocation](dev/runners/profiles.md) and the [Codex runner](dev/runners/codex.md).

**Upgrading from shared permission limits:** Review APP permissions before upgrading the controller. A PROFILE which previously limited an APP to read-only access will no longer restrict the APP's own writes. Move required restrictions to the APP or its TEAM.
