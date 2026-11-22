# MCP connections for the Codex runner

The released runner supports shared HTTP MCP servers selected from a PROFILE and HTTP servers defined by an APP. The PROFILE methods `codex.mcp.get`, `codex.mcp.set` and `codex.mcp.delete` manage shared entries. A caller can import a bearer token from a file it can read. The runner filters servers before initialization according to their source and the network permissions below. OAuth, stdio and their management operations are planned. Separate probes tested those protocols with Codex CLI 0.170.0. [HTTP MCP configuration](https://github.com/flinbein/pappai-runner-codex#http-mcp)

## Connection sources and permissions

A PROFILE holds shared MCP definitions and credentials for each server. An APP selects the shared connections it needs and can add its own servers with separate credentials. For example, two APPs might share one task service account while each connects to a personal calendar. At launch the runner builds the permitted server list for that worker. An empty list is valid.

| Connection | Permissions while serving the APP |
|---|---|
| APP-defined HTTP server | Requires the APP's effective network permission. |
| Profile-provided HTTP server | Requires network permission for **both** the APP and the selected PROFILE. The controller passes their combined network decision in `job.profileMcpNetwork` for a profiled job. |
| APP-defined stdio server (planned) | The subprocess uses the APP's effective permissions. |
| Profile-provided stdio server (planned) | The subprocess uses the intersection of the APP's and the selected PROFILE's effective permissions, including filesystem and network access. |

These limits apply to the individual server. When computing the PROFILE network decision, the controller matches node selectors in the PROFILE's permission rules against the APP that will use the connection. If the result denies access, the controller also clears the profile server selection in the dispatched settings so runners that read the selection directly enforce the same decision. APP-defined servers stay in the settings and are subject to the APP's network permission. The worker's own sandbox and ordinary controller calls use the [APP's permissions](profiles.md#worker-permissions).

The server name, address or launch command, and credential source identify a connection. Conflicting names in the selected set require a configuration change or a distinct name. Changing the address cannot transfer an existing secret to another server. In the design for APP-local credentials, credentials belong to the APP ID and survive restarts. Copying the manifest does not copy them.

## Managing connections

The proposed management interface targets the PROFILE or APP that owns the entry. All calls require the usual method permit. The released PROFILE methods are listed above.

| Method | Effect |
|---|---|
| `codex.mcp.get` | Lists connection settings and status with secrets omitted. Reading settings does not start MCP. |
| `codex.mcp.set`, `codex.mcp.delete` | Change an entry for its owner. Deletion also clears local secrets and any unfinished authorization for that entry. |
| `codex.mcp.auth`, `codex.mcp.logout` (planned) | Authorize a connection or delete saved local access. Revocation at the provider depends on its API. |
| `codex.mcp.test` (planned) | Check connectivity, MCP initialization and tool discovery without executing an arbitrary tool. |

For planned PROFILE `auth` and `test` operations, a launched program or network request must be allowed by both the **caller** and the **target PROFILE**. The call has no assigned APP worker whose rights it can borrow. Operations on APP-owned entries use the caller's and target APP's permissions. The controller identifies the caller and target from the active call. The request cannot nominate another APP to lend permissions.

In the stdio probe, native `codex mcp login` on 0.170.0 returned “OAuth login is only supported for streamable HTTP servers” without starting the command. An `auth` method can report this unsupported login mode immediately. Any future runner-specific stdio setup procedure must apply the same permits and sandbox.

## Trust boundary

- **HTTP MCP.** The runner excludes a server before initialization when the network decision for its source is false, including a local gateway for profile credentials. The same principle applies to MCP test and authorization under the management permissions above. The connection between Codex and its model uses a separate service channel.
- **stdio MCP (planned).** A trusted wrapper runs each user-supplied command inside bubblewrap, including launches for `auth` and `test`. It builds mounts, network access and the environment from the actual assignment. Launch must fail if isolation cannot be established. Profile service directories, configuration, launchers and gateway keys must stay out of reach even when the command has broad access to a parent directory.
- **Codex settings.** The trusted runner builds a server list and protected constraints for each worker. Codex reads trusted project settings as well as `CODEX_HOME`. The probe successfully used a worker-private `/etc/codex/requirements.toml` to permit specific names and HTTP addresses. For stdio, the wrapper invocation must be bound to the controller assignment. Matching a command name alone cannot authenticate its arguments, environment or working directory. User-supplied executable configuration helpers also require controlled execution.
- **Shutdown (planned stdio).** The runner owns the stdio sandbox and closes it when access is revoked, the worker stops or the control connection drops. EOF may stop the server gracefully. The sandbox owner must also be able to terminate a server that ignores EOF.

## Shared OAuth and token rotation (prototype)

Each shared grant needs one owner for its refresh token. In the prototype a profile app-server stores native credentials in its isolated `CODEX_HOME`. Two separate worker app-servers access it through an authenticated local gateway. Each keeps its own local MCP credentials in its own directory. MCP OAuth with Codex file storage uses a separate `.credentials.json` file. Importing Codex's own credentials from `auth.json` is documented under [runner profiles](profiles.md).

Rotating a shared refresh token invalidates the old copy. Copying the profile file into each APP causes a later refresh to fail. The shared owner must coordinate refreshes, and the gateway must check the assignment on every connection and cut off revoked access. The prototype exercised one tool through the gateway. Integration acceptance still requires full MCP support, gateway key protection, owner recovery and verification of revocation on a live worker.

## Reproducible probes

| Probe | What it checks |
|---|---|
| [Configuration layers](../../../tests/probes/codex-layers/README.md) | Two APPs, shared and personal servers, definitions from user and trusted project configurations. Compares tool listings with actual HTTP requests to each server. |
| [Shared and personal OAuth](../../../tests/probes/codex-oauth/README.md) | On Windows and Linux, two APPs received one shared identity and distinct personal identities. Checks restart, repeated rotations, concurrent recovery after access-token revocation and rejection of a stale copy and another worker's gateway key. |
| [stdio under bubblewrap](../../../tests/probes/codex-stdio/README.md) | Actual read, write, network and environment access from an MCP tool, process shutdown and launch failure when a namespace is unavailable. |

See the [Codex advanced configuration guide](https://developers.openai.com/codex/config-advanced) and [configuration reference](https://developers.openai.com/codex/config-reference) for configuration sources and managed constraints.
