# Serving and updating the web interface

The controller serves [pappai-web](https://github.com/flinbein/pappai-web) at `/` and the authenticated terminal at `/terminal`. Its dependency lock pins a tested frontend release for new installations. The compiled panel and terminal use the controller origin for sessions, passkeys, RPC and WebSockets. The npm package contains ready-to-serve assets.

## Update the running panel

The default Compose configuration mounts `./web-releases` read-only at `/run/pappai/web`. Set `PAPPAI_WEB_DIR` to choose another host directory. Only platform administrators should be able to write it. Frontend code executes with the signed-in user's session. On custom installations, set `PAPPAI_WEB_ROOT` to the directory visible to the controller.

Run the following on the machine that owns the writable release directory. Use the version of pappai-web whose API is compatible with your controller. The installer uses Node.js, npm and tar.

```sh
npm run web:install -- 0.1.1 ./web-releases
```

On a Docker-only host, run the installer in a temporary container using the controller image and the same host directory. With the default Compose configuration:

```sh
docker run --rm -v "$PWD/web-releases:/web" "$(docker compose images -q controller)" npm run web:install -- 0.1.1 /web
```

The installer reuses a retained release or the bundled package when versions match. For other versions it fetches the exact npm package. It checks both entry points and their assets, then atomically selects the release by replacing `current`. New page loads use that release immediately. Existing pages and terminal sockets continue on their original release. Reloading the terminal tab closes its shell.

To roll back, run the same command with a previously installed version. To select the version bundled in the controller, remove the `current` file. Keep old release directories while clients may still request their assets. HTML is fetched fresh. Assets under `/_web/<version>/assets/` can be cached indefinitely for the lifetime of the release.

## Development

Run the web project's Vite development server for frontend changes. The [frontend README](https://github.com/flinbein/pappai-web#development) documents the proxy setup. Run this repository's `tests/browser-acceptance.mjs` against a compiled package to verify registration, node management, terminal behavior and live release switching.
