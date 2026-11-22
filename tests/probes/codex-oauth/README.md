# Shared PROFILE OAuth and private APP OAuth for MCP

Run with Node.js and Codex CLI 0.170.0 in PowerShell.

```powershell
node tests/probes/codex-oauth/probe.mjs (Get-Command codex.exe).Source
```

On Linux, pass the path to the Codex binary as the last argument. The probe can run in a container with `--network none`. The HTTP provider and gateway bind to random loopback ports. The three native OAuth logins use PKCE and fictitious accounts. Each `CODEX_HOME` is inside a separate temporary directory removed on exit. The model is never called.

Two app-server processes call `whoami` concurrently through `mcpServer/tool/call`. Their private servers have the same name and URL. A's native credentials produce `alice` and B's produce `bob`. For the shared server both go through a local gateway that checks the executor key and calls `whoami` through a single profile app-server. Its credentials identify `team` to the provider. An empty profile exposes no tools. A's key on B's route receives HTTP 403.

The test accelerates expiry only in its synthetic files while processes are stopped. The provider accepts each refresh token once and immediately revokes the old token pair. Each of the three owners survives a restart and two successive rotations. A stale copy of the profile credentials receives `invalid_grant`. In another test the provider revokes the profile access token while both executors are running. Two concurrent calls must succeed after a single shared refresh.

The gateway implements one synthetic tool and verifies route ownership. Full gateway support for MCP resources, prompts, streaming, approvals and different OAuth providers requires separate tests. Filesystem permissions, key delivery and agent command isolation are outside this probe.
