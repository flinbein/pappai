# Preparing a runner in the terminal

In the web panel, select the workspace and **Add runner**. Choose **npm** or **Git**, enter the source, and review the editable installation name. **Custom path** derives the name from an existing entrypoint under the runner root. The installer terminal can keep working while you visit another node in the same browser tab. Successful preparation registers the runner. If registration fails, retry from the same screen to reuse the prepared files.

To update an existing runner, select its installation in the same form. The active host stays up during download. Switching releases restarts its workers. After a successful switch, **Roll back** selects the previous entrypoint. A normal restart keeps the current version.

The controller image includes `/opt/pappai/scripts/prepare-runner.mjs`. An administrator can run it in an unrestricted container terminal. Mount a persistent volume at `/run/pappai/private` to keep installed releases across container replacements.

```sh
node /opt/pappai/scripts/prepare-runner.mjs add npm codex '@flinbein/pappai-runner-codex@latest'
node /opt/pappai/scripts/prepare-runner.mjs update git codex https://github.com/flinbein/pappai-runner-codex.git master
```

Use a registry package name with an optional version, range or tag. Git accepts an HTTPS repository URL and an optional branch, tag or commit. The default ref is the repository's HEAD. The installer installs production dependencies with npm lifecycle scripts disabled. A Git checkout must contain its ready-to-run entrypoint. A lockfile selects `npm ci`.

The package declares its file in `package.json` under `pappai.runner` or `main`. The path must point to a regular file inside the package. On success the final output line contains `PAPPAI_RESULT {"entrypoint":"..."}`. Pass that absolute path to the [runner registry](registry.md) to activate the release.

Each runner has its own directory at `/run/pappai/private/runners/<name>`. The first installation requires an empty or absent directory. If registration failed after preparation, select the custom path and use the entrypoint from the terminal. Repeating `add` prints that path. An `update` prepares another release inside the existing installation, or starts a new private tree when migrating an older runner from elsewhere.

The installer stages downloads separately and publishes a complete release with a directory rename. It records the source and relative entrypoint in `releases/<id>/source.json`. A per-name SQLite lock in `.locks` serializes preparation and registry changes and releases automatically when the process exits. Installation leaves previous releases available to the controller during restart and rollback.
