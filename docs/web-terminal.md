# Web terminal

Sign in and open the terminal from the panel. Each tab opens an independent interactive `/bin/sh` inside the Linux container. The terminal follows the window size and supports arrow keys, Ctrl+C and interactive console programs.

The header shows the execution mode. With a restricted permission chain, the terminal uses bubblewrap with the USER's effective file and network permissions. Its working directory and `HOME` are the user's private `/tmp`, shared between that user's sandboxes. With a fully trusted chain of `permissions: null`, the regular terminal starts in `/root` with the rights of the pappai process inside the container. The sandbox option for such users provides read-only base system directories, a writable private `/tmp` and no external network.

Closing the terminal or tab, or losing the connection, terminates the shell. In a sandbox this also terminates background processes. In an administrator's regular terminal, a detached job with redirected streams, such as `nohup command </dev/null >job.log 2>&1 &`, may continue running. Opening a new terminal creates a separate shell. Signing out closes terminals for that web session.

Keep files that must survive container replacement on a mounted persistent volume such as `/workspace`. Grant the USER access to the relevant directory. [Workspace permissions](workspace.md) · [Terminal internals](dev/web-terminal.md)
