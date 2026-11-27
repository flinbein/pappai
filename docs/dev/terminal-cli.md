# Terminal CLI

The container installs `pappai` at `/usr/local/bin/pappai`. A sandboxed shell connects to the Unix socket mounted at `/run/pappai/terminal.sock`. The controller binds the caller identity and file view to the listening endpoint. Commands and their descendants share that endpoint. Each request from a web sandbox requires a valid browser session. The CLI prints JSON results on stdout and sends errors to stderr with a nonzero exit status.

The built-in process runner also mounts this socket in each sandboxed APP executor. From that process, `pappai me` returns the APP, and `pappai run` starts a child inside the executor's filesystem and network limits. The socket is specific to one executor and closes when it exits. The APP can continue to use its usual JSONL protocol in parallel.

| Command | Operation |
| --- | --- |
| `pappai me` | Return `{id,parentId,type,name}` for the effective caller. The workspace has a null parent. Available on every RPC socket. |
| `pappai checkPermissions JSON` | Check a concrete action against the current permissions. See [permission checks](../permissions.md#checking-and-narrowing-permissions). |
| `pappai call NODE METHOD [JSON]` | Call a method with JSON data. The default input is `{}`. |
| `pappai help [--schema] [--doc] NODE [FEATURE]` | Request help. Flags include the schema and documentation when available. |
| `pappai discover [JSON]` | Request the visible node directory. The current operation lists all visible entries. |
| `pappai emit EVENT [JSON]` | Publish an application event as the effective caller. |
| `pappai cli NODE METHOD [JSON]` | Prepare an interactive CLI feature with the supplied JSON and relay its PTY. |
| `pappai cli NODE METHOD -- [ARG ...]` | Supply `{"args":[...]}` as feature input. The feature must accept this input shape. |
| `pappai run PROGRAM [ARG ...]` | Start a separate bubblewrap process. Everything after `run` is the program and its literal arguments. |

## Command options

Place wrapper options **before the command**. `-u NODE_ID` (or `--as`) selects a working USER, APP or TEAM through the local administrator socket. `-r NODE_ID` (also `--restrict` or `--restrict-to`) adds a permission subject while preserving the caller identity. Repeat it to require every named subject's effective permission. `--permissions JSON` adds another ordered permission list. Restrictions on the parent socket remain active. For checks on a new foreign subject, the caller needs `checkPermissions` on that node.

```sh
pappai -u IVAN_USER me
pappai -r IVAN_USER discover
pappai -r IVAN_USER call TELEGRAM_APP telegram.sendMessage '{"chatId":42,"text":"Ready"}'
pappai --permissions '[{"node":"SUPPORT_TEAM/**","discover":true}]' help SUPPORT_APP
pappai run node -e 'console.log(process.version)'
pappai -r IVAN_USER --with-rpc run pappai discover
```

`run` starts with a fresh temporary directory and a small environment. When the caller has unrestricted filesystem access, a plain `run` uses the standard read-only runtime mounts and private `/tmp`. A file grant can make a project directory available. The child keeps the caller's working directory when it is present in the child sandbox and falls back to `/tmp` otherwise. In a sandbox, a working subdirectory beneath the parent's private `/tmp` can serve as the shared task directory. Keep unrelated files outside that subtree. The child uses a PTY for an interactive terminal. With redirected input or output it preserves binary stdin, stdout, stderr and the command's exit status.

By default the child has no RPC socket. `--with-rpc` passes a separate socket representing the parent's identity and all inherited limits, including any PROFILE action's permitted method and target. The controller checks current permissions on every RPC and before each new process launch. Already-running processes retain their filesystem mounts and network namespace until exit. These rules also apply to processes started by a child.

The terminal launcher pins filesystem grants by descriptor before starting bubblewrap. A read-only directory can contain a separate writable grant. A nested overlay requires a stable destination. The launcher rejects overlays beneath writable mounts and paths whose intermediate directory the enclosing caller can rename. Give writable data its own directory when a sibling must remain private.

An ordinary manual WebSocket launch accepts `{argv,env?,cols?,rows?}` or the older `{command,cols?,rows?}`. The Python bridge passes the argument array directly to exec. It splits the legacy command with POSIX quoting. Environment overrides apply only to the requested program. The controller reserves names starting with `PAPPAI_`.

A feature launch accepts `{cli:{node,method,input},cols?,rows?}`. The controller checks the caller's CLI grant and asks the runner to prepare the action. It pins each approved regular file by descriptor and mounts that inode read-only at `/run/pappai/cli/0`, `/run/pappai/cli/1`, and so on inside a new sandbox. An unrestricted caller's action receives the standard read-only system mounts, private `/tmp` and network access. The optional forced sandbox of an ordinary unrestricted shell also restricts its nested actions' network access. For a restricted caller, the caller's sandbox determines filesystem and network access.

The runner's `@cli.prepare` reply can include `calls: ["setup", "status"]`. Each name grants one method in this runner's namespace on the target PROFILE, subject to the caller's current permissions. Actions with calls can also use `me` and `run`. An empty list omits the socket. When omitted, the list defaults to empty except for the existing `authorize` feature, which defaults to `setup` and `status`. Action sockets reject nested CLI feature launches, impersonation and unrelated RPC.

`PAPPAI_CLI_TMP` names a unique writable directory within the action's `/tmp`. Its backing directory lives under the controller's `/run`. Another sandbox sharing the USER's private temporary directory sees only an empty mount point. A profile import uses the caller's actual mounted scratch directory and intersects the launching file permissions with current USER permissions. The controller removes the scratch contents after the process exits, including when it kills an action on disconnect.

Running `pappai cli` from a shell forwards the nested PTY's bytes, terminal size and exit status through the current terminal. The client restores the outer terminal's attributes on completion. One web connection supports up to four nested action levels and sixteen simultaneous processes or preparations. Closing the terminal revokes its brokers, cancels pending requests and terminates its children.

The Linux controller running as root also listens at `/run/pappai-admin/rpc.sock` in a root-owned directory with mode 0700. This directory is outside sandbox mounts. The CLI uses that endpoint in a direct container shell. Its default caller is the workspace (`~`). The controller logs local administrative operations with their effective caller. Each sandbox broker rejects the identity override on the server. Neither endpoint requires environment credentials.

Run the Linux PTY and broker tests inside the pappai image with namespaces enabled and `PAPPAI_TEST_BWRAP=1` using `node --test tests/terminal.test.ts tests/terminal-cli.test.ts tests/profile-cli.test.ts`.
