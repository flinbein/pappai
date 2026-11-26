# Serving and updating the web interface

The controller serves [pappai-web](https://github.com/flinbein/pappai-web) on the same origin as sessions, passkeys, RPC and WebSockets. Its dependency lock pins a tested frontend release for new installations. The npm package contains ready-to-serve assets.

## Controller routes

On the panel host, `GET /`, `/runners`, `/rpc`, `/nodes/<id>` and action paths below a node serve the active release's `index.html`. This lets a user open or reload a specific method or creation form. The panel reads the session before loading workspace data. The controller checks permissions independently for each operation. Browsing `/files/` uses the authenticated server-side directory handler. APP hosts route requests to the corresponding APP.

`GET /terminal` (including `?sandbox=1`) requires a session and redirects signed-out visitors to `/`. This route serves `terminal.html` from the active release. In the integrated panel it loads the workspace with the terminal selected. Older packages supply the standalone terminal under the same filename. Workspace HTML permits inline styles so xterm.js can render after navigation from any pane.

HTTP session and passkey requests use `/api/session` and `/api/auth/*`. The panel uses a SharedWorker to share one `/api/ws/web` connection across browser windows in the same login session for RPC and [event subscriptions](../app-exchange.md#user-and-browser-tab-subscriptions). Standalone HTTP clients can use `POST /api/rpc`. Each terminal the user starts opens its own binary `/api/ws/terminal` connection. [Terminal protocol](web-terminal.md)

Deploy the controller with workspace deep-link support before activating the integrated panel. It also accepts the preceding panel's routes, including `POST /rpc`, during rollout.

The control socket uses the `ws` server's default incoming message limit (100 MiB in the current release). HTTP RPC accepts bodies up to 1 MiB. The separate terminal socket retains its 64 KiB incoming message limit.

## Update the running panel

The default Compose configuration mounts `./web-releases` read-only at `/run/pappai/web`. Set `PAPPAI_WEB_DIR` to choose another host directory. Only platform administrators should be able to write it. Frontend code executes with the signed-in user's session. On custom installations, set `PAPPAI_WEB_ROOT` to the directory visible to the controller.

Run the following on the machine that owns the writable release directory. Use the version of pappai-web whose API is compatible with your controller. The installer uses Node.js, npm and tar.

```sh
npm run web:install -- 0.1.3 ./web-releases
```

On a Docker-only host, run the installer in a temporary container using the controller image and the same host directory. With the default Compose configuration:

```sh
docker run --rm -v "$PWD/web-releases:/web" "$(docker compose images -q controller)" npm run web:install -- 0.1.3 /web
```

The installer reuses a retained release or the bundled package when versions match. For other versions it fetches the exact npm package. It checks both entry points and their assets, then atomically selects the release by replacing `current`. New page loads use that release immediately. Existing pages and terminal sockets continue on their original release. The stable module entry at `/api/web-worker-v1.js` loads the active versioned worker. Windows with the same session and worker protocol can reconnect to the existing worker across a release. The worker binds both panel and terminal sockets to the non-secret `browserSession` identifier returned by `/api/session`. The upgrade still requires the matching authenticated cookie. A browser without SharedWorker support uses per-page sockets and closes its terminals on reload.

To roll back, run the same command with a previously installed version. To select the version bundled in the controller, remove the `current` file. Keep old release directories while clients may still request their assets. HTML is fetched fresh. Assets under `/_web/<version>/assets/` can be cached indefinitely for the lifetime of the release.

## Development

Run the web project's Vite development server for frontend changes. The [frontend README](https://github.com/flinbein/pappai-web#development) documents the proxy setup. Run this repository's `tests/browser-acceptance.mjs` against a compiled package to verify registration, node management, terminal behavior and live release switching.
