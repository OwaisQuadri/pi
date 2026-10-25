# Command help and version

A user can inspect the available commands and source version without starting an interactive session.

## Sub-features

- `cli-help` prints the command options and exits successfully.
- `cli-help-alias` gives the same output with the short option.
- `cli-version` prints the source version and exits successfully.
- `cli-version-alias` gives the same version with the short option.

## How to get to it (user POV)

- Run `./pi-test.sh --help` or `./pi-test.sh -h` from the source checkout.
- Run `./pi-test.sh --version` or `./pi-test.sh -v` from the source checkout.

## Driving it with tmux

Preconditions:

- The [launch helper](../SKILL.md#launch) resolves this checkout's `pi-test.sh`.
- The helper uses an empty profile and a clean environment.

- **Help.** The helper runs `pi-test.sh --help` and `pi-test.sh -h` before the terminal starts. Both exit successfully. Their saved output matches and contains `--no-session`.
- **Version.** The helper runs `pi-test.sh --version` and `pi-test.sh -v`. Both exit successfully. Their saved output matches.
- **Proof.** Inspect `help.txt`, `help-short.txt`, `version.txt`, and `version-short.txt` in the evidence directory.

## Gotchas

- This path proves command output, not a provider response or a release installation.
- A runtime import error fails the journey before the terminal starts.
- Use the source driver, not a globally installed `pi` from another revision.
