# Installing the Codex runner and CLI

The external runner is distributed as an npm package from [pappai-runner-codex](https://github.com/flinbein/pappai-runner-codex). The administrator selects the runner and Codex CLI versions independently. [First Codex APP](../../codex.md)

Open **Add runner** on the workspace, choose **npm**, enter `@flinbein/pappai-runner-codex`, and confirm the installation name. Each named installation owns a persistent directory under `/run/pappai/private/runners/`. The managed runner installs the native Codex CLI on first launch. Check progress with `runners.<name>.getVersion` on the workspace. Change the CLI version separately through `runners.<name>.installCodex({version})`.

For the default name `codex`, PROFILE credentials and persistent conversations retain their storage under `/run/pappai/private/profiles` and `/run/pappai/private/state`. Other named installations isolate their state. Removing the runner deletes its dedicated package and CLI files and preserves PROFILE and APP data.

## Upgrade

Prepare a release from the workspace and switch the entrypoint with `$.runners.restart({name,entrypoint})`. The previous package is available for rollback. A package rollback changes runner code only. CLI versions, credentials and stored conversation formats have their own lifecycle. See [installation](install.md) and [runner protocol](registry.md).

## Verification

On Alpine Linux x86_64 with Codex CLI 0.170.0, the [end-to-end test](../../../tests/codex-package.test.ts) installs the packaged archive, registers the runner, imports a credentials file accessible to the caller, sets `scope` and invokes APP methods. It checks a one-shot agent's output JSON Schema, restoration of a persistent agent's history after restart, and controller responses to permitted and denied operations.

In the [session history probe](../../../tests/probes/codex-sessions/README.md), two app-servers shared test Codex credentials and used separate state directories. After container recreation, each resumed its own conversation with its previous context. Even with the other thread's ID, `thread/resume` could not open it. The probe uses a local mock model and API-key authentication. Integration tests separately check that APP commands cannot read the other worker's files directly.
