# A persistent APP with a public webhook

The Linux image includes a [webhook example](../examples/webhook/webhook.mjs) and its [file manifest](../examples/webhook/pappai-manifest.json). The process receives HTTP over a private Unix socket and checks a request secret. Incoming requests require `http:true`. Outbound connections require a separate `network:true` permission.

Set `PAPPAI_APP_HOST_TEMPLATE` on the controller, for example `{name}.apps.example.org`. Configure DNS, TLS and original Host forwarding on the reverse proxy for those names. The panel uses its own host from `PAPPAI_ORIGIN`.

Choose `call` in the panel and create the example APP. Replace the example secret with your own value.

```json
{
  "node": "~",
  "method": "$.children.createApp",
  "data": {
    "name": "Webhook",
    "httpName": "telegram-demo",
    "permissions": [
      {"read": "/opt/pappai/examples/webhook", "http": true},
      {"node": ".", "events": ["$.lifecycle.statusChanged","$.app.restarted","$.app.executors.failed"]},
      {"node": "~", "events": "$.workspace.init"}
    ],
    "source": {
      "file": "/opt/pappai/examples/webhook/pappai-manifest.json",
      "override": {"run":{"settings":{"env":{"TELEGRAM_WEBHOOK_SECRET":{"secret":"replace-me"}}}}}
    }
  }
}
```

Open and start the new APP. Its manifest subscribes to the transition to `working`, controller startup and APP restarts. The first event starts the socket listener. Test the address of your installation.

```sh
curl https://telegram-demo.apps.example.org/healthz
curl https://telegram-demo.apps.example.org/webhook \
  -H 'X-Telegram-Bot-Api-Secret-Token: replace-me' \
  -H 'Content-Type: application/json' -d '{"update_id":42}'
```

Both requests return `200 ok`. An incorrect webhook secret returns 403. For a known, permitted name the proxy returns 503 while the APP is stopped, restarting or still opening its socket. An HTTP request alone does not launch a process. New connections after restart go to the new executor's socket. If the connection drops, the client decides whether it can safely repeat the request.

## Update a package

The controller watches one self-contained JSON file. It checks the path with the APP's own permissions on each read. The manifest directory is the default working directory for a file source. Relative `cwd` in the file or override resolves against that directory. An inline source requires an absolute `cwd` for the process runner.

Overrides support `run.settings.cwd`, `run.settings.env`, `subscriptions` and executor settings including `poolSize`, one-shot `maxLifetimeMs`, and persistent `idleTimeoutMs` and `maxRestarts`. The override subscription list replaces the package list. Environment variables merge by name. A value of `null` removes a variable. Saving `{"secret":true}` keeps the existing secret under that name. Omitting the name from the new override removes its override value.

A valid file update immediately changes the one-shot pool's contract. A persistent process can receive its local `$.app.manifest.sourceChanged` event through the active subscriptions. The previous manifest stays active until exit or restart. Failure to read the active file stops the APP. Correct the file and start the APP again. Granting permission to install from a directory includes trust in future changes by its publisher. For delegated installation, restrict the directory, allowed override fields and new APP permissions in the argument schema. Use paths without symbolic links for such installations.

[Manage an APP](manage-app.md) · [File sources and HTTP routing](dev/manifest-http.md)
