# Web terminal internals

The workspace loads local copies of xterm.js and FitAddon for its terminal pane. Each launched terminal owns one xterm instance, WebSocket and PTY. The launch form owns none. Switching workspace panes or selecting another terminal preserves these instances. A tab keeps its rendered output when its socket closes. Fullscreen, keyboard focus and the screen wake lock belong to the visible terminal. OSC 0 and OSC 2 update that terminal's display title through xterm's `onTitleChange`.

The carousel keeps inactive panels mounted and inert. Each tab owns its theme. Changing a palette updates the existing xterm instance and CSS colors while preserving the PTY, scrollback and other tabs. Copy mode snapshots the active buffer and remembers soft-wrapped lines so copying a wrapped command preserves its text.

The mobile page uses the browser's visual viewport for keyboard layout. In fullscreen, subtract only the portion of the terminal box below the visible bottom edge. This also handles a browser that already resized the entire layout for the keyboard.

On touch devices the fullscreen terminal anchors xterm's invisible input inside the visible area. Following the terminal cursor to the top edge can make Android Chrome pan the entire surface when the keyboard opens, even when the DOM reports the correct toolbar bounds. To verify a layout change on a phone, open fullscreen and the keyboard in both orders, then hide and reopen the keyboard. Compare the painted toolbar edge with the keyboard edge.

During the `/api/ws/terminal` upgrade, the controller checks the Host, Origin, active session cookie and USER status. The `sandbox=1` parameter can only tighten isolation. The controller verifies that incoming data belongs to an active session. Logging out closes that session's connections. A heartbeat checks session expiry and detects lost connections.

The [terminal CLI](terminal-cli.md) describes argument-array and CLI-feature launches, the terminal broker and action isolation.

The web client opens `/api/ws/terminal?start=manual` and sends the command in `argv`, optional environment in `env` and the starting dimensions in `cols` and `rows`. A CLI feature launch sends `cli` alongside the starting dimensions. Older clients can send a quoted command string in `command`. It may also request `sandbox=1`. After the executable starts, the server sends `started: true`, the executable name in `program`, and the effective `sandboxed` flag. A confirmed startup failure carries `{startFailed:true,error}`. A program exit carries `{exitCode}`, including nonzero exits. A socket that disappears without a final status is a lost connection. Clients using the earlier terminal endpoint without `start=manual` still receive the default interactive shell and the earlier mode/error messages.

Binary messages carry PTY bytes in both directions. Client text messages set the terminal size or acknowledge the number of bytes xterm.js has rendered. The controller can pause PTY reads while waiting for acknowledgement. The server keeps no terminal history.

The controller launches a Python bridge that uses `pty.fork()`. In sandboxed mode, the bridge creates the controlling PTY **inside** the new PID namespace after bubblewrap setup. The bridge runs as PID 1 and reaps children. On disconnect, the controller sends SIGKILL to bubblewrap, and `--die-with-parent` tears down the namespace. In direct mode the bridge terminates its shell and closes the PTY. Startup errors appear in the affected tab.

Run `node tests/browser-acceptance.mjs` to check independent terminal tabs, program titles, launch errors, resizing, Ctrl+C, USER permissions, logout and detached jobs. When scripting input into Alpine's interactive BusyBox shell, wait for a test keystroke to echo at a fresh prompt. The shell queries the cursor position as it prints the prompt and can consume the first bytes of immediately pasted input while reading the reply. [User guide](../web-terminal.md)
