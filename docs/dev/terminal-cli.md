# USER terminal CLI

The container installs `pappai` at `/usr/local/bin/pappai`. Each web terminal process receives a Unix socket path and a random token. The controller authenticates each connection against that terminal's launch and checks the browser session before dispatching a request. It supplies the USER identity and mounted file view to the controller operation. The CLI prints JSON results on stdout and sends errors to stderr with a nonzero exit status.

| Command | Operation |
| --- | --- |
| `pappai call NODE METHOD [JSON]` | Call a method with JSON data. The default input is `{}`. |
| `pappai help [--schema] [--doc] NODE [FEATURE]` | Request help. Flags include the schema and documentation when available. |
| `pappai discover [JSON]` | Request the visible node directory. The current operation lists all visible entries. |
| `pappai emit EVENT [JSON]` | Publish an event as the USER. |
| `pappai cli NODE METHOD [JSON]` | Prepare an interactive CLI feature with the supplied JSON and relay its PTY. |
| `pappai cli NODE METHOD -- [ARG ...]` | Supply `{"args":[...]}` as feature input. The feature must accept this input shape. |

An ordinary manual WebSocket launch accepts `{argv,env?,cols?,rows?}` or the older `{command,cols?,rows?}`. The Python bridge passes the argument array directly to exec. It splits the legacy command with POSIX quoting. Environment overrides apply only to the requested program. The controller reserves names starting with `PAPPAI_`.

A feature launch accepts `{cli:{node,method,input},cols?,rows?}`. The controller checks the USER's CLI grant and asks the runner to prepare the action. It pins each approved regular file by descriptor and mounts that inode read-only at `/run/pappai/cli/0`, `/run/pappai/cli/1`, and so on inside a new USER sandbox. Each action receives its own broker endpoint. An unrestricted USER's action receives the standard read-only system mounts, private USER `/tmp` and network access. The optional forced sandbox of an ordinary unrestricted shell also restricts its nested actions' network access. For a restricted USER, the USER's sandbox determines filesystem and network access.

`PAPPAI_CLI_TMP` names a unique writable directory within the action's `/tmp`. Its backing directory lives under the controller's `/run`. Another sandbox sharing the USER's private temporary directory sees only an empty mount point. A profile import uses the caller's actual mounted scratch directory and intersects the launching file permissions with current USER permissions. The controller removes the scratch contents after the process exits, including when it kills an action on disconnect.

Running `pappai cli` from a shell forwards the nested PTY's bytes, terminal size and exit status through the current terminal. The client restores the outer terminal's attributes on completion. One web connection supports up to four nested action levels and sixteen simultaneous processes or preparations. Closing the terminal revokes its brokers, cancels pending requests and terminates its children.

The host socket is under `/run`, outside shared USER temporary storage. Sandboxed clients receive only their own socket at `/run/pappai/terminal.sock`. The per-process token travels over the launcher's stdin and is installed in the executed program's environment. It is absent from bubblewrap arguments. Direct, unrestricted root shells have administrator access to the container.

Run the Linux PTY and broker tests inside the pappai image with namespaces enabled and `PAPPAI_TEST_BWRAP=1` using `node --test tests/terminal.test.ts tests/terminal-cli.test.ts tests/profile-cli.test.ts`.
