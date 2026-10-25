# Draft editing

A user can type a draft, clear it, and continue editing without sending a model request.

## Sub-features

- `editor-draft` displays literal input in the real editor.
- `editor-clear` removes the draft with the default clear key.
- `editor-continue` accepts a different draft after the clear.

## How to get to it (user POV)

- Start `./pi-test.sh` in a terminal.
- Type in the editor without pressing Enter.
- Press Ctrl+C once while the editor contains text.

## Driving it with tmux

Preconditions:

- Use the [launch helper](../SKILL.md#launch).
- Its doctor check passes before input.
- The empty profile supplies the default keybindings.

- **Type.** The helper sends `tmux -S "$socket" send-keys -t pi-verify -l 'pi-verify-draft-marker'`. The marker appears in `01-draft.txt`.
- **Clear.** The helper sends `tmux -S "$socket" send-keys -t pi-verify C-c`.
- **Continue.** The helper types `pi-verify-clear-confirmation` without Enter. The new marker appears in `02-clear.txt`. The old marker is absent.
- **Proof.** Inspect both snapshots with `actions.txt` and `terminal.ansi`. The application remains usable for the settings journey.

## Gotchas

- Enter submits a draft. This journey never submits ordinary text.
- Two Ctrl+C presses within 500 milliseconds can exit the app, even when the editor contains text.
- A populated user profile can change the default keys. Use the helper's isolated profile.
- This journey does not prove streaming, multiline input, prompt submission, or provider access.
