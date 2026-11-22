# Developing pappai

The controller owns the node tree, permissions, queues and call state. A runner manages workers, enforces isolation and provides the controller with the APP's method and event contract. One runner can serve several APPs.

- [First end-to-end build](first-milestone.md) lists the steps and expected results.
- [Web terminal internals](web-terminal.md) describes WebSocket authentication, the PTY and process cleanup.
- [Restoring both volumes](restore.md) covers backups, restoration and verification.
- [Roadmap](roadmap.md) lists the stages after the first build and links to acceptance criteria.
- [Controller design](architecture-review.md) explains call ownership, configuration changes and trust in package publishers.
- [The process runner](runners/process.md) describes stdin delivery and the call lifecycle.
- [Workspace and APPs](../workspace.md) explains how to configure the platform.

## Build verification

Run `npm ci`, `npm run typecheck` and `npm test` to check the server-side TypeScript and local scenarios. Enable Linux bubblewrap tests with `PAPPAI_TEST_BWRAP=1` on a host that allows the required namespaces. Run `node tests/browser-acceptance.mjs` to check the local Docker build in Chromium with a virtual authenticator. Set `PAPPAI_CHROME_BIN` to provide the browser path if necessary.

## Protocols

- [Runner registry](runners/registry.md)
- [Installing the Codex runner and CLI](runners/codex.md)
- [Runner profiles](runners/profiles.md) and [MCP connections](runners/mcp.md)
- [Manifest sources and HTTP](manifest-http.md)
- [File transfers](runners/files.md)
