# Restoring both volumes

The `platform` volume holds the SQLite database and platform data. The `workspace` volume holds user files. Stop the controller before taking a snapshot of both volumes. Keep the archive in a private operator directory because the database contains account information and active web sessions.

On Linux with the Compose file from this repository, create an archive from the project directory.

```sh
umask 077
mkdir -p backups
docker compose stop controller
docker compose run --rm --no-deps -v "$PWD/backups:/backup" controller \
  tar czf /backup/workspace.tgz -C / var/lib/pappai workspace
docker compose start controller
```

To verify the backup, deploy the same version to a separate test installation with **two new, empty volumes**. Place the archive in that installation's `backups` directory and extract it before starting the controller.

```sh
docker compose run --rm --no-deps -v "$PWD/backups:/backup:ro" controller \
  tar xzf /backup/workspace.tgz -C /
docker compose up -d controller
```

Verify a file with known contents in `/workspace`, the node tree, the active manifest and a method call. To test the original passkey, the browser needs the original RP ID and an allowed origin. The automated test uses temporary volumes and a test passkey. It stops one container and opens a second one at the same address with the restored data. [Browser acceptance test](../../tests/browser-acceptance.mjs)

To associate an image with a revision, run `docker build --label "org.opencontainers.image.revision=$(git rev-parse HEAD)" -t "pappai:$(git rev-parse --short HEAD)" .` in a clean checkout. Preserve the released image or its registry digest alongside the backup for an exact restore. The Alpine base image and its packages can change.
