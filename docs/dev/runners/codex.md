# Installing the Codex runner and CLI

The external runner is distributed as an npm package from [pappai-runner-codex](https://github.com/flinbein/pappai-runner-codex). The administrator selects the runner and Codex CLI versions independently. [First Codex APP](../../codex.md)

| Component | Location in the container | Configuration |
|---|---|---|
| Runner package and dependencies | For example, `/run/pappai/private/runners/` on a persistent volume | The administrator registers the absolute entry point path in the [registry](registry.md). |
| Complete native Codex CLI distribution | For example, `/run/pappai/private/tools/codex/<version>/` on the same volume | The administrator sets the absolute path to the native executable in `config.codexExecutablePath`. |
| Credentials, history and MCP | Separate private `profilesDir` and `stateDir` directories under `/run/pappai/private/` | The [PROFILE](profiles.md) provides the connection. The APP owns its history. |

Files on a persistent volume survive container replacement when the volume is remounted at the same path. Ordinary image directories, including `/opt`, need a separate mount for this. Copy the complete distribution with its bundled resources and utilities. If an npm installation uses the wrapper as its entry point, keep the wrapper and its platform dependency as well.

The controller stores the `config` supplied at registration in SQLite and delivers it only to the trusted runner host on each start. The administrator must control the executables, configuration and their parent directories. Update the configuration through `$.runners.restart({name,config})`. Restricted workers must have no alternate path to the volume mounted at `/run/pappai/private`.

## Upgrade

1. Install the runner or complete CLI in a new versioned directory. Keep the previous installation until verification is complete.
2. In the target image, run the selected CLI by its absolute path. Check `--version` and the `initialize` exchange with `codex app-server`. CLI changes may require another check of MCP and sandbox behavior.
3. Switch the administrative path and restart the runner through `$.runners.restart`. To roll back, restore the path to the previous compatible version and restart again.

## Verification

On Alpine Linux x86_64 with Codex CLI 0.170.0, the [end-to-end test](../../../tests/codex-package.test.ts) installs the packaged archive, registers the runner, imports a credentials file accessible to the caller, sets `scope` and invokes APP methods. It checks a one-shot agent's output JSON Schema, restoration of a persistent agent's history after restart, and controller responses to permitted and denied operations.

In the [session history probe](../../../tests/probes/codex-sessions/README.md), two app-servers shared test Codex credentials and used separate state directories. After container recreation, each resumed its own conversation with its previous context. Even with the other thread's ID, `thread/resume` could not open it. The probe uses a local mock model and API-key authentication. Integration tests separately check that APP commands cannot read the other worker's files directly.
