# Pi verification map

This map owns the initial offline interface journeys.
Read the index before a run, then read each feature that the change affects.
The executable driver owns the exact terminal commands and assertions.

## Preconditions

- Run from a source checkout with the dependencies from the repository's `README.md`.
- Use the [launch command](../SKILL.md#launch) with a new evidence directory.
- Use only the private terminal and empty profile that the helper creates.
- Leave production accounts, sessions, memories, and installed applications unchanged.
- Submit no model prompt during these journeys.

## Proof

Keep the action log, raw terminal output, numbered snapshots, and exit results from the same run.
Inspect the source and session-file checks alongside the visible states.
A passing editor path does not prove provider access.
A passing settings path does not prove an external question host.
Record an unmet precondition in the matching feature's `Gotchas`.
Keep every failed run's evidence.

## Features

- [Command help and version](command-help.md) covers the long and short command options.
- [Draft editing](draft-editing.md) covers text entry and clearing an unsubmitted draft.
- [Settings](settings.md) covers entry, scrolling, narrow resize, cancellation, and restored editor focus.

Other Pi features are outside this initial map.
Do not report them as verified by these journeys.
