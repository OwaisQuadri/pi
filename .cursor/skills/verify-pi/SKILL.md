---
name: verify-pi
description: >-
  Verify Pi's command-line and terminal interfaces with an isolated automated tmux driver.
  Use for editor or settings changes and source-startup checks.
  Skip provider billing, installed-package acceptance, and external memory-review extensions.
---

# Verify Pi

JOB: Drive the source CLI (command-line interface) and TUI (terminal user interface), then retain the proof.
IN: A source checkout with its documented dependencies, Z shell, tmux, ripgrep, and fd.
OUT: An evidence directory with actions, terminal output, snapshots, exit codes, and cleanup results.

## Launch

Read [the feature map](features/README.md) before the run.
Use the dependency and source-startup instructions in the repository's `README.md`.
The helper uses the existing `pi-test.sh` driver.
It does not install dependencies or build packages.
Report a missing dependency before any drive.

Pi does not scan `.cursor/skills` by default.
Start Pi with `--skill .cursor/skills/verify-pi` to load this skill.
The helper checks that explicit registration in an empty profile.

Run these commands from the repository root:

```zsh
EVIDENCE="$(mktemp -d "${TMPDIR:-/tmp}/pi-verify-evidence.XXXXXX")/proof"
./.cursor/skills/verify-pi/helpers/drive.zsh "$EVIDENCE"
```

The helper creates an empty home, agent profile, project, session directory, and private tmux server.
It ignores the user's tmux configuration.
It starts the real source application with automatic resource discovery and tools disabled.
It loads only this verification skill through the explicit command option.
The version banner and a live editor establish readiness.
The empty profile can show `No models available`.
That warning is expected for this offline interface check.

Each run owns its socket and scratch directory.
Concurrent runs share neither data nor terminals.
The helper cleans up after success, failure, or interruption.

## Doctor

The helper performs this read-only check before it sends input:

```zsh
tmux -S "$socket" display-message -p -t pi-verify '#{pane_dead} #{pane_current_path}'
```

Here, `socket` is the private socket that the helper creates.
Require a live pane in the disposable project directory.
Require the banner in `00-ready.txt` to match `version.txt`.
Require `00-resources.txt` to show `verify-pi`.
The helper records the source revision and runtime versions.
If this check fails, inspect the retained output before another run.

## Drive

The executable [driver](helpers/drive.zsh) owns the exact commands and assertions.
It exercises all three mapped features in one run.
It sends input through tmux to the real terminal application.
It types drafts without submitting them to a model.
It opens settings, scrolls the list, resizes the terminal, cancels, and quits.
The helper waits for visible text with bounded retries.

Read the matching feature file before interpreting its result.
A failure remains a failure.
A missing precondition does not permit a weaker journey.

## Evidence

Inspect `actions.txt`, `terminal.ansi`, and the numbered snapshots together.
The raw terminal stream starts before the first feature action.
It is terminal evidence, not a video or a native-window screenshot.
The settings journey does not prove an external memory-review dialog.

Require `result.txt` to report `PASS` and `exit-code.txt` to contain `0`.
Require `app-exit.txt` to show a clean application exit.
Compare the before-and-after source records.
Require `session-files.txt` to remain empty.
This checks the observed effect of `--no-session`.

The run makes no provider-response, billing, or network-isolation claim.
It proves no memory write, migration, installed version, or historical intake.
Those checks need their own authorized production paths.
Do not commit temporary evidence or private runtime paths.

## Cleanup

The helper closes the application with `/quit`.
Its exit trap stops only its private tmux server.
It removes only the scratch directory that this run creates.
It retains the evidence directory after a failed run too.

After the command returns, run:

```zsh
test -s "$EVIDENCE/cleanup.txt" && test -s "$EVIDENCE/terminal.ansi"
test "$( < "$EVIDENCE/exit-code.txt" )" = 0
```

A cleanup failure or missing proof fails the run.
Do not stop a shared tmux server or another session.

## Helpers

`helpers/drive.zsh <new-evidence-directory>` is the complete automated interface check.
The directory must not exist before the command starts.
The helper needs no credentials or permission grants.
A failed source-startup check does not authorize an installation or a catalogue refresh.

Use `/maintain-verification-skill` when app changes affect these commands or the feature map.
