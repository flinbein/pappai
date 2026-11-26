# Make your first method call

You need Docker with Linux containers, Compose and a browser with passkey support. Run these commands from the repository root.

```sh
docker compose up --build -d
docker compose exec controller node src/admin.ts admin owner@example.org
```

Open `http://localhost:3000`. In the passkey registration form, enter your email and the one-time code from the terminal. Confirm creation of the key on your device. Subsequent sign-ins use the passkey without asking for an email address. [Registration and recovery](passkeys.md)

Open **RPC console** in the panel menu, choose `call` and send the following request. It creates a stopped APP directly under the workspace. The example script is included in the image.

```json
{
  "node": "~",
  "method": "$.children.createApp",
  "data": {
    "name": "extract-text",
    "permissions": [{"read": "/opt/pappai/examples/extract-text"}],
    "source": {"manifest": {
      "run": {"type":"process","settings":{
        "cwd":"/opt/pappai/examples/extract-text","command":"node","args":["extract.cjs"],
        "features":{"message.extractText":{"type":"method","description":"Trim leading and trailing whitespace","version":"1","schema":{
          "input":{"type":"object","required":["text"],"properties":{"text":{"type":"string"}},"additionalProperties":false},
          "output":{"type":"string"}
        }}}
      }},
      "executors":{"mode":"oneShot","poolSize":1}
    }}
  }
}
```

Replace `APP_ID` with the returned `id` and submit these requests through the same form.

| Operation | JSON parameters | Result |
|---|---|---|
| `call` | `{"node":"APP_ID","method":"$.lifecycle.start"}` | The APP enters `working`. |
| `discover` | `{}` | Visible APPs include their status. |
| `help` | `{"node":"APP_ID","features":"message.**","schema":true}` | Method description, version and schema. |
| `call` | `{"node":"APP_ID","method":"message.extractText","version":"1","data":{"text":"  Hello  "}}` | The string `"Hello"`. |

To create a TEAM or USER, call `$.children.createTeam` or `$.children.createUser` on the parent. For a USER supply `name`, `email` and optional `permissions` (default `[]`). Start it with `$.lifecycle.start` and issue a code with the `otp` command. For example, `[{"discover":true}]` allows discovery but denies `message.extractText`. Try signing in as that USER in a separate browser profile. [TEAM defaults and delegated creation](permissions.md#delegate-a-team-branch)

Run `docker compose stop` to stop the local installation. The `platform` volume stores settings and accounts. The `workspace` volume stores user files. The local Compose configuration grants the container `SYS_ADMIN` and disables the outer seccomp profile so bubblewrap can create nested namespaces. Validate the host configuration separately before deploying with least privilege.
