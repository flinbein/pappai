# Web terminal

Sign in and open the terminal from the panel. Each tab opens an independent interactive `/bin/sh` inside the Linux container. The terminal follows the window size and supports arrow keys, Ctrl+C and interactive console programs.

Use the row beneath the terminal for Esc, Tab, the arrow keys and Ctrl. Tap Ctrl followed by C to interrupt the foreground command. Tap an active modifier again to cancel it. The **⋯** button reveals Alt, Home, End, PgUp, PgDn, common shell characters and font controls. **A−** and **A+** change the font size on this device. Tap the displayed size to reset it. The fullscreen button appears in browsers that support it.

Select output and press **Копировать** (Copy). With no selection, the button opens a selectable text view of the terminal buffer, including scrollback. **Вставить** (Paste) reads the clipboard or opens a text field where you can use the system paste menu and confirm. Pasted line breaks are passed to the terminal. Desktop Ctrl+Shift+C and Ctrl+Shift+V use the same actions.

The header shows the execution mode. With a restricted permission chain, the terminal uses bubblewrap with the USER's effective file and network permissions. Its working directory and `HOME` are the user's private `/tmp`, shared between that user's sandboxes. With a fully trusted chain of `permissions: null`, the regular terminal starts in `/root` with the rights of the pappai process inside the container. The sandbox option for such users provides read-only base system directories, a writable private `/tmp` and no external network.

Closing the terminal or tab, or losing the connection, terminates the shell. In a sandbox this also terminates background processes. In an administrator's regular terminal, a detached job with redirected streams, such as `nohup command </dev/null >job.log 2>&1 &`, may continue running. Opening a new terminal creates a separate shell. Signing out closes terminals for that web session.

Keep files that must survive container replacement on a mounted persistent volume such as `/workspace`. Grant the USER access to the relevant directory. [Workspace permissions](workspace.md) · [Terminal internals](dev/web-terminal.md)
