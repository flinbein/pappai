# USER terminal CLI

The container installs `pappai` at `/usr/local/bin/pappai`. A sandboxed shell connects to the Unix socket mounted at `/run/pappai/terminal.sock`. The controller binds the caller identity and file view to the listening endpoint. Commands and their descendants share that endpoint. Each request from a web sandbox requires a valid browser session. The CLI prints JSON results on stdout and sends errors to stderr with a nonzero exit status.

| Command | Operation |
| --- | --- |
| `pappai me` | Return `{id,parentId,type,name}` for the effective caller. The workspace has a null parent. Available on every RPC socket. |
| `pappai call NODE METHOD [JSON]` | Call a method with JSON data. The default input is `{}`. |
| `pappai help [--schema] [--doc] NODE [FEATURE]` | Request help. Flags include the schema and documentation when available. |
| `pappai discover [JSON]` | Request the visible node directory. The current operation lists all visible entries. |
| `pappai emit EVENT [JSON]` | Publish an application event as the effective caller. |
| `pappai cli NODE METHOD [JSON]` | Prepare an interactive CLI feature with the supplied JSON and relay its PTY. |
| `pappai cli NODE METHOD -- [ARG ...]` | Supply `{"args":[...]}` as feature input. The feature must accept this input shape. |

An ordinary manual WebSocket launch accepts `{argv,env?,cols?,rows?}` or the older `{command,cols?,rows?}`. The Python bridge passes the argument array directly to exec. It splits the legacy command with POSIX quoting. Environment overrides apply only to the requested program. The controller reserves names starting with `PAPPAI_`.

A feature launch accepts `{cli:{node,method,input},cols?,rows?}`. The controller checks the caller's CLI grant and asks the runner to prepare the action. It pins each approved regular file by descriptor and mounts that inode read-only at `/run/pappai/cli/0`, `/run/pappai/cli/1`, and so on inside a new sandbox. An unrestricted caller's action receives the standard read-only system mounts, private `/tmp` and network access. The optional forced sandbox of an ordinary unrestricted shell also restricts its nested actions' network access. For a restricted caller, the caller's sandbox determines filesystem and network access.

The runner's `@cli.prepare` reply can include `calls: ["setup", "status"]`. Each name grants one method in this runner's namespace on the target PROFILE, subject to the caller's current permissions. Actions with calls can also use `me`. An empty list omits the socket. When omitted, the list defaults to empty except for the existing `authorize` feature, which defaults to `setup` and `status`. Action sockets reject nested CLI launches, impersonation and unrelated RPC.

`PAPPAI_CLI_TMP` names a unique writable directory within the action's `/tmp`. Its backing directory lives under the controller's `/run`. Another sandbox sharing the USER's private temporary directory sees only an empty mount point. A profile import uses the caller's actual mounted scratch directory and intersects the launching file permissions with current USER permissions. The controller removes the scratch contents after the process exits, including when it kills an action on disconnect.

Running `pappai cli` from a shell forwards the nested PTY's bytes, terminal size and exit status through the current terminal. The client restores the outer terminal's attributes on completion. One web connection supports up to four nested action levels and sixteen simultaneous processes or preparations. Closing the terminal revokes its brokers, cancels pending requests and terminates its children.

The Linux controller running as root also listens at `/run/pappai-admin/rpc.sock` in a root-owned directory with mode 0700. This directory is outside sandbox mounts. The CLI uses that endpoint in a direct container shell. Its default caller is the workspace (`~`). Prefix any command with `-u NODE_ID` to use a working USER's or APP's permissions and file view. For example, `pappai -u IVAN_USER discover` returns Ivan's directory. The controller logs local administrative operations with their effective caller. Each sandbox broker rejects the identity override on the server. Neither endpoint requires environment credentials.

Run the Linux PTY and broker tests inside the pappai image with namespaces enabled and `PAPPAI_TEST_BWRAP=1` using `node --test tests/terminal.test.ts tests/terminal-cli.test.ts tests/profile-cli.test.ts`.
