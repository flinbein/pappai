# Web terminal

Sign in and open **Terminal** from the sidebar or visit `/terminal`. The **+** tab shows a launch form. Press Enter or select the start button to run the command. The default is `/bin/sh -i`. To start a different installed program, enter its name and arguments, for example `node` or `node "/workspace/my script.js"`. The launcher understands quotes. For a shell pipeline, explicitly invoke a shell, for example `/bin/sh -c 'ls /tmp | sort'`.

Use **+** again to open another terminal. Each terminal has its own process, input and scrollback. Switching tabs or visiting another workspace pane keeps the terminals running. The tab displays the program name or its current title. Hover over the status icon to see the state or exit code.

Use **Edit as rows** to enter individual arguments, including empty strings. In compact input, quote arguments containing spaces and escape a literal quote or backslash. An unfinished quote or escape must be corrected before starting. Expand **Environment** to add variables for this process.

A node can advertise an interactive action in its help with `type:"cli"`. Open that action to see its terminals, select **+** and choose **Run**. The form validates the arguments and environment against the feature's schema. On the main **Terminal** page these sessions appear in groups by node and action. The group label shows the method followed by the node name. Expand it to see its sessions inside a colored outline. Swipes skip collapsed groups. Groups slide open and closed. Closing a tab slides the remaining tabs into place. Both transitions respect the system’s reduced motion setting. Collapsing the active session's group selects **+** and keeps its sessions running. Closing a starting or running session, or a group containing one, requires confirmation. [Try interactive Codex login](codex.md)

In a terminal, `pappai discover` lists visible nodes and `pappai help --doc NODE_ID` displays their help. Use `pappai call NODE_ID METHOD '{}'` to call a method and `pappai cli NODE_ID FEATURE` for an interactive action. These commands use the signed-in USER's permissions. [Command reference](dev/terminal-cli.md)

Choose a theme on **+**, or use **🎨** in the tools row to change the active terminal. The theme colors its ANSI output, tab and toolbar. The browser remembers the last choice for new terminals. Each open tab keeps its own theme.

| Icon | Meaning |
| --- | --- |
| Yellow ring | The terminal is connecting or starting its program. |
| Green circle | The program started. |
| Gray square | The program exited with code 0 or the connection ended without a reported exit code. |
| Red square | The program exited with a nonzero code. Hover over the square for the code. |
| Red cross | Startup failed. The tab displays the startup error in place of the terminal. |

When a program exits, its tab keeps the output for reading and copying. The **×** on a tab removes it and ends its connection. Other terminal tabs stay open. Reloading or closing the browser tab ends all its terminal connections. Signing out closes the terminals for that web session.

The toolbar starts hidden. With the terminal focused, tap and release Shift twice to open the clipboard, font and fullscreen controls. Tap the screen with two fingers to open the input keys. Repeat the same gesture on its open row to hide it. Tap the screen to open the keyboard. In a terminal program that enables mouse input, a short tap also sends a left click at the touched cell. Swipe to scroll, pinch to resize the text, or hold a word to select it and drag the handles to adjust the selection.

The input row has Esc, Tab, arrows, Ctrl, Alt and Shift. A selected modifier stays active across toolbar presses. Tap it again to release it, or type on your keyboard to use it once and release it. For example, select Alt and swipe left twice for two Alt+Left presses. Select Shift to send Shift+arrow or reverse Tab. Tap or hold the arrow pad for instructions. Drag in the desired direction to send an arrow and keep holding after the drag to repeat.

After Shift, the input row has **Nav**, **Fn**, **Ins** and **Del**. On Nav, swipe up for Page Up, down for Page Down, left for Home or right for End. Hold after a vertical swipe to repeat. Ins sends Insert and Del deletes forward in programs that support it. These keys honor the selected modifiers.

Tap **Fn** to show F1–F12. Swipe horizontally to reach the later keys on a narrow screen. Tap a function key to send it with the selected modifiers and return to the input row. Tap **↩** on the right to return without sending a key.

A visible, connected terminal requests a screen wake lock in both ordinary and fullscreen views. The request is released when you hide or close the terminal and renewed when you return to a connected terminal. This requires a secure context and a browser that supports screen wake locks. Device power-saving settings can override the request.

Tap ☰ to switch to Copy, Paste, A+, A−, theme and fullscreen. Tap ⌨ to return to the input keys. Both switches stay at the right edge while you scroll the other buttons. Hold a button to read its hint. Releasing after a hold performs no button action. Copy and Paste also support the desktop shortcuts Ctrl+Shift+C and Ctrl+Shift+V.

Copying with no selection opens a read-only snapshot at the current scroll position. Use the system selection handles, **Copy selected** or **Copy all**. Escape, **×**, a two-finger tap or double Shift returns to the terminal. If the browser denies clipboard access, the paste action opens a text field for the system paste menu. Pasted line breaks are sent to the terminal.

Swipe horizontally with two fingers on the terminal or a trackpad to move between tabs and the launch form. On a tab with a startup error, the gesture works across the entire pane, including the empty area below the message. The carousel stops at each end. Pinching on a trackpad or touchscreen adjusts the terminal font.

Use **Ctrl+Shift+Enter**, a three-finger tap or the fullscreen button to toggle fullscreen. Fullscreen shows only the terminal and its optional toolbar. With a restricted permission chain, the terminal uses bubblewrap with the USER's effective file and network permissions. Its working directory and `HOME` are the user's private `/tmp`, shared between that user's sandboxes. With a fully trusted chain of `permissions: null`, the regular terminal starts in `/root` with the rights of the pappai process inside the container. The sandbox option for such users provides read-only base system directories, a writable private `/tmp` and no external network.

The program runs with the USER's effective permissions. A private executable or PROFILE login used by an APP runner remains subject to those permissions. In a sandbox, ending the session also terminates background processes. In an administrator's regular terminal, a detached job with redirected streams, such as `nohup command </dev/null >job.log 2>&1 &`, may continue running.

Keep files that must survive container replacement on a mounted persistent volume such as `/workspace`. Grant the USER access to the relevant directory. [Workspace permissions](workspace.md) · [Terminal internals](dev/web-terminal.md)
