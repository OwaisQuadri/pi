# Settings

A user can open settings, scroll to another item, resize the terminal, cancel, and return to the editor.

## Sub-features

- `settings-open` shows the settings list.
- `settings-resize` keeps the list visible in a narrow terminal.
- `settings-scroll` moves to a named item outside the initial viewport.
- `settings-cancel` closes the list without selecting a value.
- `settings-focus` returns keyboard input to the editor.

## How to get to it (user POV)

- Enter `/settings` in the editor.
- Use Down to move through the list.
- Resize the terminal window.
- Press Escape to cancel.

## Driving it with tmux

Preconditions:

- Use the [launch helper](../SKILL.md#launch).
- The doctor and draft journeys pass first.
- The empty profile supplies the initial settings and default keys.

- **Open.** The helper types `/settings` and sends Enter. `03-settings.txt` shows `Auto-compact`.
- **Resize.** The helper runs `tmux -S "$socket" resize-window -t pi-verify -x 54 -y 18`. `04-narrow.txt` still shows `Auto-compact`. `dimensions.txt` confirms the terminal size.
- **Scroll.** The helper presses Down until `Cache warming` is selected. `05-scroll.txt` shows that item. `Auto-compact` no longer appears.
- **Cancel.** The helper sends `tmux -S "$socket" send-keys -t pi-verify Escape`. It types `pi-verify-after-cancel` without Enter. `06-cancel.txt` shows the editor marker and no `Cache warming` item.
- **Quit.** The helper clears the draft and enters `/quit`. `app-exit.txt` reports a clean exit.
- **Proof.** Inspect all settings snapshots with the action log and raw terminal stream. Require the source and session-file checks to pass too.

## Gotchas

- Enter or Space changes a setting. This journey uses neither key inside the list.
- Narrow terminals can clip supporting text. A visible item alone does not establish complete layout quality.
- This journey proves the settings list, not the memory-review conversation or its consent rules.
- A new setting order can change the initial viewport. Repair the driver only when observed behavior changes.
