# Web terminal

Sign in and open the terminal from the sidebar or visit `/terminal`. Each workspace tab can run one interactive `/bin/sh` inside the Linux container. Move to another node or panel action and return to the terminal to continue with the same shell. Opening the terminal in another browser tab gives that tab its own shell. The terminal follows the pane size and supports arrow keys, Ctrl+C and interactive console programs.

The toolbar starts hidden. With the terminal focused, tap and release Shift twice to show or hide it. On a phone, tap with two fingers for the same action. Tap the screen to open the keyboard, swipe to scroll, or pinch to resize the text. Hold a word to select it and drag the handles to adjust the selection.

The input row has Esc, Tab, arrows, Ctrl, Alt and Shift. A selected modifier stays active across toolbar presses. Tap it again to release it, or type on your keyboard to use it once and release it. For example, select Alt and swipe left twice for two Alt+Left presses. Select Shift to send Shift+arrow or reverse Tab. Tap or hold the arrow pad for instructions. Drag in the desired direction to send an arrow and keep holding after the drag to repeat.

Tap ☰ to switch to Copy, Paste, A+, A− and fullscreen. Tap ⌨ on the right to return to input keys. Hold a button to read its hint. Releasing after a hold performs no button action. Copy and Paste also support the desktop shortcuts Ctrl+Shift+C and Ctrl+Shift+V.

Copying with no selection opens a selectable text view that includes scrollback. If the browser denies clipboard access, the paste action opens a text field for the system paste menu. Pasted line breaks are sent to the terminal.

The workspace displays the execution mode and session controls above the terminal. Fullscreen shows only the terminal and its optional toolbar. With a restricted permission chain, the terminal uses bubblewrap with the USER's effective file and network permissions. Its working directory and `HOME` are the user's private `/tmp`, shared between that user's sandboxes. With a fully trusted chain of `permissions: null`, the regular terminal starts in `/root` with the rights of the pappai process inside the container. The sandbox option for such users provides read-only base system directories, a writable private `/tmp` and no external network.

When the shell exits, you close the session, or the terminal loses its connection, the cursor disappears. Output remains available to read and copy. Start a new session explicitly to get another prompt. Reloading or closing the tab terminates its shell. Signing out closes terminals for that web session.

In a sandbox, ending the shell also terminates background processes. In an administrator's regular terminal, a detached job with redirected streams, such as `nohup command </dev/null >job.log 2>&1 &`, may continue running. Open `/terminal?sandbox=1` to request sandbox isolation.

Keep files that must survive container replacement on a mounted persistent volume such as `/workspace`. Grant the USER access to the relevant directory. [Workspace permissions](workspace.md) · [Terminal internals](dev/web-terminal.md)
