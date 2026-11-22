# Sign-in and account recovery

The controller and admin CLI use the SQLite database in `PAPPAI_DB` (default `data/pappai.sqlite`). Run the CLI inside the container with the live controller's data volume mounted.

## First administrator

Run this command from the repository root as the installation operator.

```sh
npm run admin -- admin owner@example.org
```

The command creates a working USER with full permissions at the workspace root and prints a one-time passkey registration code. Open the panel at its configured public address, enter the email and code, then confirm passkey creation on your device. The code lasts ten minutes. After exchanging it, the browser has thirty minutes to finish registration. Registering a key for a working USER also opens a web session. For later visits, select passkey sign-in and confirm on your device.

Use `http://localhost:3000` for development. External access requires HTTPS through a reverse proxy that preserves the original `Host`. This address determines the panel origin and passkey domain. Use a browser that supports WebAuthn, JSON credential conversion and discoverable credentials.

## Issue a code to an existing USER

```sh
npm run admin -- otp user@example.org
```

Issuing a code replaces the previous code from the same channel. Existing passkeys remain valid. A stopped USER can register a key and can sign in once its node starts. The local CLI and email form issue separate codes.

### Email recovery

Select email recovery on the sign-in form. The USER needs permission to call `$.user.recovery.send` and `$.user.passkeys.create` on itself. An authorized caller can also call the first method from the panel. The controller checks registration permission when adding the key. An address can receive up to ten messages per day, at least ten minutes apart. The public form gives the same response for every address.

Set `PAPPAI_SMTP_HOST`, `PAPPAI_SMTP_FROM`, `PAPPAI_SMTP_USER` and `PAPPAI_SMTP_PASSWORD` in the controller environment. TLS on port 465 is the default. Use `PAPPAI_SMTP_TLS=starttls` for STARTTLS on port 587. Override the port with `PAPPAI_SMTP_PORT`.

**Administrator recovery** uses the same `admin` command as initial setup. Running it for an existing email moves the account to the workspace root, grants full permissions, and revokes existing keys and sessions. To add another key while keeping existing access, use `otp`.

Each session belongs to a specific passkey. Sessions last up to thirty days and expire after one day of inactivity. Signing out ends the current session.
