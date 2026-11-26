# Run a Codex APP

As an administrator, open **Add runner** on the workspace, select **npm** and install `@flinbein/pappai-runner-codex` as `codex`. The first launch installs the native Codex CLI. Check its progress through the workspace method `runners.codex.getVersion`. Mount a persistent volume at `/run/pappai/private` for installed code, profile credentials and runner state. [Installation and updates](dev/runners/install.md)

## From the web panel

1. Select the workspace and open **Add runner**. If `codex` is already installed, proceed to the next step.
2. Select the workspace in the tree. Choose **Create TEAM** and give the team a name. The panel selects the new team. Choose **Create PROFILE** inside it.
3. Open **codex.authorize** on the PROFILE and run it. Visit the verification URL printed in the terminal and enter its code there. When the terminal exits with code 0, call `codex.status` with `{}` on the same PROFILE and check for `{"configured":true}`. This works on a newly created, stopped PROFILE. Successful authorization replaces any previous credentials for that runner on this PROFILE.
4. Select the TEAM again and create **APP · Codex**. Choose the PROFILE you created. This template declares a persistent agent with message, history and interrupt methods. The permissions editor defaults to `[]`. Grant workspace permissions separately when the agent needs tools.
5. Return to the PROFILE and open its settings. Choose the new APP in the scope dropdown, save the scope, then enable the profile. The dropdown appends the selected ID to the rules shown in the editor.
6. Select the APP. Under **Manage APP**, choose **Start**. Open **Message agent** to send a message and read the reply. To read earlier messages, select `agent.getHistory` under **Documentation** and call it with `{}`.

You can also start the same interactive login inside an existing pappai terminal:

```sh
pappai cli PROFILE_ID codex.authorize
pappai call PROFILE_ID codex.status '{}'
```

The USER needs the `cli` permission for `codex.authorize`, ordinary method permissions for `codex.setup` and `codex.status`, and network access for device login. Use your normal USER terminal when starting this command. If an administrator explicitly checks **Run in sandbox** on an ordinary terminal, that minimal sandbox disables networking for its nested commands. To import an existing file instead, use **Profile settings → Import Codex credentials**. For aliased installations, substitute the registered runner name for `codex`.

## Equivalent method calls

| Target | Method | Arguments |
|---|---|---|
| Workspace or TEAM | `$.children.createProfile` | `{"name":"shared","permissions":null}` |
| New PROFILE | `codex.setup` | `{"authFile":"/tmp/codex-auth.json"}` |
| Workspace or TEAM | `$.children.createApp` | Supply the name, APP permissions, profile ID in `profile` and manifest in `source.manifest`. |
| PROFILE | `$.profile.scope.set` | `{"scope":["APP_ID"]}` using the new APP's ID |
| PROFILE | `$.lifecycle.start` | `{}` |
| APP | `$.lifecycle.start` | `{}` |
| APP | `agent.execute` | `{"input":"Summarize the following text …"}` |

`codex.setup` reads the file using the caller's file permissions. For a sandboxed USER, `/tmp` is their private temporary directory. Check the import with `codex.status({})`. To revoke access, disable the profile with `$.lifecycle.stop`, then remove the connection with `codex.remove`. To recover an APP after access was denied, restore authorization and scope, enable the profile and call `$.lifecycle.start`.

The [example manifests](https://github.com/flinbein/pappai-runner-codex/tree/master/examples) declare `agent.execute`. A one-shot executor returns the result of one task. A persistent executor preserves conversation history across launches. The controller checks the caller, method permission and declared schema.

The PROFILE selects the authorization the APP can use. The APP's effective permissions govern its own files, network tools and pappai calls. For example, two APPs can share one model login while writing to different directories. An HTTP MCP configured by the APP requires APP network access. An HTTP MCP selected from the PROFILE requires network access for both the APP and the PROFILE. Model access is independent of tool network access. See [profile scope and revocation](dev/runners/profiles.md) and the [Codex runner](dev/runners/codex.md).

**Upgrading from shared permission limits:** Review APP permissions before upgrading the controller. A PROFILE which previously limited an APP to read-only access will no longer restrict the APP's own writes. Move required restrictions to the APP or its TEAM.
