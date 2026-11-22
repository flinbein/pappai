# Run a Codex APP

Install the [runner package and CLI distribution](https://github.com/flinbein/pappai-runner-codex#installation). Register the runner on the workspace with `$.runners.add`, which requires unrestricted permissions. Mount a dedicated persistent volume at `/run/pappai/private` for profile credentials and runner state.

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
