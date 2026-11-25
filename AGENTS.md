# Working on pappai

pappai manages a tree of teams, users, profiles and applications. The controller checks permissions and routes events and method calls. Runners start APP executors.

- Start with the [wiki](docs/README.md). User documentation covers people and agents configuring a workspace. The [developer guide](docs/dev/README.md) covers controller internals, implementation decisions and runner contracts.
- Update documentation in the same change as the behavior it describes. Keep examples current and record non-obvious implementation decisions in `docs/dev/`.
- Write the pappai interface, user-facing messages, repository documentation and project-provided `help()` content in English. Keep private design notes in `.dev/` in Russian.
- Keep wiki pages short, focused and linked with relative paths. Identify planned behavior explicitly.
