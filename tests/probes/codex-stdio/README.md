# Probe stdio MCP under a pappai sandbox policy

The test starts Codex CLI 0.170.0 with an empty `CODEX_HOME`. An ephemeral thread supplies `mcp_servers` through `thread/start.config`. A trusted wrapper starts a fixed MCP server using [sandboxArgs](../../../src/sandbox.ts), passes bubblewrap arguments through fd 3 and reads status on fd 4. The client lists tools through `mcpServerStatus/list` with a `threadId`, then calls `inspect` through `mcpServer/tool/call`. The thread needs no model call. Each container has only loopback and a separate temporary directory. A local Codex distribution is sufficient.

## Reproduce

From the repository root in PowerShell, build the Linux image with `docker build -t pappai:acceptance .` if necessary. Run `npm pack @openai/codex@0.170.0-linux-x64`, extract the archive and point `$native` to its `package/vendor/x86_64-unknown-linux-musl` directory. The example assumes the archive was extracted into the project's private probe directory.

```powershell
$native = (Resolve-Path '.dev/codex-package-probe/0.170.0/package/vendor/x86_64-unknown-linux-musl').Path
$probe = (Resolve-Path 'tests/probes/codex-stdio').Path
$policy = (Resolve-Path 'src/sandbox.ts').Path
foreach ($mode in 'online','offline','codex-eof','codex-kill','denied') {
  $flags = @()
  if ($mode -ne 'denied') { $flags = @('--cap-add','SYS_ADMIN','--security-opt','seccomp=unconfined') }
  docker run --rm --init --network none @flags `
    --mount "type=bind,source=$native,target=/codex,readonly" `
    --mount "type=bind,source=$probe,target=/fixture/tests/probes/codex-stdio,readonly" `
    --mount "type=bind,source=$policy,target=/fixture/src/sandbox.ts,readonly" `
    -e PAPPAI_CODEX_NATIVE=/codex/bin/codex --entrypoint node pappai:acceptance `
    /fixture/tests/probes/codex-stdio/run.mjs $mode
  if ($LASTEXITCODE -ne 0) { throw "Probe failed in mode $mode" }
}
```

## Results on November 22, 2026

The probe used Docker Engine 29.8.1, Alpine 3.24.2 x86_64, Node 24.21.0, bubblewrap 0.12.0 and MCP protocol `2025-06-18`. The client discovered and called the single `inspect` tool in all four successful connections.

| Mode | Observation |
|---|---|
| `online` | With `network:true`, MCP read a marker over HTTP on container loopback. SIGTERM to MCP produced a `TERM` marker. |
| `offline` | With `network:false`, connecting to the same address returned `ECONNREFUSED`. Killing the wrapper with SIGKILL terminated its sandbox processes without a graceful-exit marker. |
| `codex-eof` | Closing stdin made app-server exit with code 0. This run produced no MCP EOF/TERM handler marker. |
| `codex-kill` | After SIGKILL to app-server, the MCP server received EOF and exited. |
| `denied` | Docker's default policy denied namespace creation. Bubblewrap exited with code 1, tool discovery returned an empty list, the call was rejected and no executable startup marker appeared. |

In successful connections MCP read the allowed file, received `EROFS` when writing to it and `ENOENT` for an existing adjacent file. The test client read the output from the writable directory. The MCP process received the explicit `FIXTURE_ALLOWED=yes` variable. `FIXTURE_OUTER_ONLY` reached the wrapper from app-server via `env_vars`. Both it and `CODEX_HOME` were absent inside MCP.

The four shutdown scenarios tracked the wrapper, bubblewrap, MCP (PID 1 in its namespace) and an ordinary child through `/proc`. All four processes were running beforehand and exited afterwards. In the app-server crash scenario the fixture handles EOF itself. The probe separately demonstrates forced termination via the known wrapper PID. These results apply to the test wrapper. Managed stdio is still outside the production runner.
