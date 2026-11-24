# Web terminal internals

The workspace loads local copies of xterm.js and FitAddon for its terminal pane. A signed-in tab owns at most one live terminal socket. Switching workspace panes preserves the PTY, its output and the socket. After the socket closes, the client keeps the rendered output in a read-only terminal until the user starts a new session or leaves the page.

During the `/api/ws/terminal` upgrade, the controller checks the Host, Origin, active session cookie and USER status. The `sandbox=1` parameter can only tighten isolation. The controller verifies that incoming data belongs to an active session. Logging out closes that session's connections. A heartbeat checks session expiry and detects lost connections.

Binary messages carry PTY bytes in both directions. Client text messages set the terminal size or acknowledge the number of bytes xterm.js has rendered. The controller can pause PTY reads while waiting for acknowledgement. Server JSON messages report the mode or an error. The server keeps no terminal history.

The controller launches a Python bridge that uses `pty.fork()`. In sandboxed mode, the bridge creates the controlling PTY **inside** the new PID namespace after bubblewrap setup. The bridge runs as PID 1 and reaps children. On disconnect, the controller sends SIGKILL to bubblewrap, and `--die-with-parent` tears down the namespace. In direct mode the bridge terminates its shell and closes the PTY. Startup errors appear in the affected tab.

Run `node tests/browser-acceptance.mjs` to check passkey sign-in, a real PTY, resizing, Ctrl+C, USER permissions, logout and what happens to a detached job in each mode. [User guide](../web-terminal.md)
