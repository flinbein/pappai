# Session history for two APPs sharing a profile

The probe starts two real Codex CLI 0.170.0 processes with separate `CODEX_HOME` directories. Both read a generated dummy `auth.json`. A local Responses API fixture checks the bearer header and returns SSE events.

On Linux x86_64 set `CODEX_DIST` to the absolute path of the extracted `package/vendor/x86_64-unknown-linux-musl` from the official `@openai/codex@0.170.0-linux-x64` package. Run the following in a POSIX shell from the repository root.

```sh
(
  set -eu
  volume=$(docker volume create)
  trap 'docker volume rm "$volume" >/dev/null' EXIT
  for stage in create restore; do
    docker run --rm --network none \
      -v "$volume:/persist" -v "$CODEX_DIST:/opt/codex:ro" \
      -v "$PWD/tests/probes/codex-sessions:/probe:ro" node:24-alpine \
      node /probe/run.mjs /opt/codex/bin/codex "$stage" /persist
  done
)
```

The first container records one turn per APP. In the second container, `thread/list` shows each APP only its own thread, `thread/resume` rejects the other APP's ID, and resuming the APP's own thread restores both messages. The fixture also checks that the next model request contains only the caller's history marker. This measures API visibility with separate homes. Direct filesystem access requires its own sandbox.
