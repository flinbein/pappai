# Check which MCP servers Codex connects to

Run from the pappai root with Python 3, Docker and an extracted Linux Codex CLI distribution. The probe was verified on x86_64 with version `0.170.0` from `npm pack @openai/codex@0.170.0-linux-x64`. Pass the extracted `package/vendor/x86_64-unknown-linux-musl` directory.

```sh
docker build -t pappai:codex-probe .
python tests/probes/codex-layers/run.py /path/to/package/vendor/x86_64-unknown-linux-musl pappai:codex-probe
```

Each container uses `--network none`. Local HTTP MCPs expose distinct tool names. The probe creates temporary APPs A and B with separate Codex homes and trusted working directories. Each home configures a shared server, a personal server and an extra server. The project adds another server and references the other APP's personal server. After `thread/start` the probe checks both `mcpServerStatus/list` and the addresses actually contacted. It requires no account or model calls.

| Container policy | Observed MCP servers |
|---|---|
| Control without managed requirements | Both APPs discover all five names, including the other APP's server. |
| Individual allowlist for A or B | Each APP sees only the shared server and its own server. |
| A disables the shared server | Only A's personal server. |
| Empty allowlist | No tools or HTTP MCP requests. |

Each managed container has its own read-only `/etc/codex/requirements.toml`. The production runner needs an isolated configuration view for each executor to express different allowlists concurrently.
