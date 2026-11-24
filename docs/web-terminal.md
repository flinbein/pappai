# Web terminal

Sign in and open the terminal from the sidebar or visit `/terminal`. Each workspace tab can run one interactive `/bin/sh` inside the Linux container. Move to another node or panel action and return to the terminal to continue with the same shell. Opening the terminal in another browser tab gives that tab its own shell. The terminal follows the pane size and supports arrow keys, Ctrl+C and interactive console programs.

On a phone, tap the terminal to open the keyboard. Tap with two fingers to show or hide the toolbar. Swipe over the terminal to scroll, or pinch to resize the text. Hold a word to select it and drag the handles to adjust the selection.

| Toolbar control | Gesture |
|---|---|
| Ctrl or Alt | Tap to apply the modifier to the next key. Tap it again to cancel. Ctrl followed by C interrupts the foreground command. |
| Tab | Tap for Tab or drag up for Shift+Tab. |
| Arrow pad | Drag in a direction to send an arrow key. Hold before dragging for Shift+arrow. Keep holding after dragging to repeat. |
| Font size | Drag up or down to resize text. Hold to restore the default size. |
| Clipboard | Drag down to copy, or up to paste. Desktop Ctrl+Shift+C and Ctrl+Shift+V use the same actions. |

Copying with no selection opens a selectable text view that includes scrollback. If the browser denies clipboard access, the paste action opens a text field for the system paste menu. Pasted line breaks are sent to the terminal.

The header shows the execution mode. With a restricted permission chain, the terminal uses bubblewrap with the USER's effective file and network permissions. Its working directory and `HOME` are the user's private `/tmp`, shared between that user's sandboxes. With a fully trusted chain of `permissions: null`, the regular terminal starts in `/root` with the rights of the pappai process inside the container. The sandbox option for such users provides read-only base system directories, a writable private `/tmp` and no external network.

When the shell exits, you close the session, or the terminal loses its connection, the terminal keeps its output available to read and copy. Start a new session explicitly to get another prompt. Reloading or closing the tab terminates its shell. Signing out closes terminals for that web session.

In a sandbox, ending the shell also terminates background processes. In an administrator's regular terminal, a detached job with redirected streams, such as `nohup command </dev/null >job.log 2>&1 &`, may continue running. Open `/terminal?sandbox=1` to request sandbox isolation.

Keep files that must survive container replacement on a mounted persistent volume such as `/workspace`. Grant the USER access to the relevant directory. [Workspace permissions](workspace.md) · [Terminal internals](dev/web-terminal.md)
