#!/bin/zsh
set -euo pipefail
umask 077

if (( $# != 1 )); then
	print -u2 'Usage: drive.zsh <new-evidence-directory>'
	exit 64
fi

repo=$(git -C "${0:A:h}" rev-parse --show-toplevel)
evidence=${1:A}
mkdir -- "$evidence"
work=$(mktemp -d "${TMPDIR:-/tmp}/pi-verify.XXXXXX")
work=${work:A}
socket="$work/tmux.sock"

TRAPEXIT() {
	local exit_code=$?
	(( ZSH_SUBSHELL == 0 )) || return "$exit_code"
	trap - EXIT
	if [[ -S "$socket" ]] && ! tmux -S "$socket" kill-server 2>/dev/null; then
		exit_code=1
		print -r -- "Private terminal cleanup failed; scratch retained: $work" > "$evidence/cleanup.txt"
	elif rm -rf -- "$work" && [[ ! -e "$work" ]]; then
		print -r -- 'Private terminal server stopped; scratch removed; evidence retained' > "$evidence/cleanup.txt"
	else
		exit_code=1
		print -r -- "Scratch cleanup failed: $work" > "$evidence/cleanup.txt"
	fi
	print -r -- "$exit_code" > "$evidence/exit-code.txt"
	exit "$exit_code"
}
trap 'exit 130' INT
trap 'exit 143' TERM

wait_screen() {
	local name=$1
	local pattern=$2
	local attempt
	for attempt in {1..100}; do
		tmux -S "$socket" capture-pane -p -t pi-verify > "$evidence/$name.txt"
		if rg -Fq -- "$pattern" "$evidence/$name.txt"; then
			return
		fi
		sleep 0.1
	done
	print -u2 -- "Timed out waiting for $name: $pattern"
	exit 1
}

mkdir -p "$work/home" "$work/project" "$work/agent" "$work/sessions"
run_env=(/usr/bin/env -i PATH="$PATH" HOME="$work/home" SHELL=/bin/zsh TERM=xterm-256color PI_CODING_AGENT_DIR="$work/agent" PI_TELEMETRY=0)
git -C "$repo" rev-parse HEAD > "$evidence/revision-before.txt"
git -C "$repo" status --porcelain=v1 > "$evidence/worktree-before.txt"
node --version > "$evidence/node-version.txt"
tmux -V > "$evidence/tmux-version.txt"
"${run_env[@]}" "$repo/pi-test.sh" --help > "$evidence/help.txt"
"${run_env[@]}" "$repo/pi-test.sh" -h > "$evidence/help-short.txt"
cmp "$evidence/help.txt" "$evidence/help-short.txt"
rg -Fq -- '--no-session' "$evidence/help.txt"
"${run_env[@]}" "$repo/pi-test.sh" --version > "$evidence/version.txt"
"${run_env[@]}" "$repo/pi-test.sh" -v > "$evidence/version-short.txt"
cmp "$evidence/version.txt" "$evidence/version-short.txt"
version=$(<"$evidence/version.txt")

print -r -- 'launch: isolated source CLI, offline startup, no tools, explicit verification skill, no session persistence' > "$evidence/actions.txt"
tmux -f /dev/null -S "$socket" new-session -d -s pi-verify -x 120 -y 64 -c "$work/project" \
	"${run_env[@]}" "$repo/pi-test.sh" --no-env --offline --no-extensions --no-mcp --no-skills --skill "$repo/.cursor/skills/verify-pi" --verbose \
	--no-prompt-templates --no-themes --no-context-files --no-tools --no-approve --no-session --session-dir "$work/sessions"
tmux -S "$socket" set-option -g remain-on-exit on
tmux -S "$socket" pipe-pane -o -t pi-verify "cat > ${(q)evidence}/terminal.ansi"
wait_screen 00-ready "v$version"
wait_screen 00-resources verify-pi
tmux -S "$socket" display-message -p -t pi-verify '#{pane_dead} #{pane_current_path}' > "$evidence/doctor.txt"
rg -Fxq -- "0 $work/project" "$evidence/doctor.txt"

print -r -- 'editor.draft: type literal pi-verify-draft-marker without Enter' >> "$evidence/actions.txt"
tmux -S "$socket" send-keys -t pi-verify -l 'pi-verify-draft-marker'
wait_screen 01-draft 'pi-verify-draft-marker'
print -r -- 'editor.clear: Ctrl+C, then type literal pi-verify-clear-confirmation without Enter' >> "$evidence/actions.txt"
tmux -S "$socket" send-keys -t pi-verify C-c
tmux -S "$socket" send-keys -t pi-verify -l 'pi-verify-clear-confirmation'
wait_screen 02-clear 'pi-verify-clear-confirmation'
if rg -Fq -- 'pi-verify-draft-marker' "$evidence/02-clear.txt"; then
	print -u2 'Draft clear failed: old marker remains'
	exit 1
fi

print -r -- 'settings.open: Ctrl+U, then /settings and Enter' >> "$evidence/actions.txt"
tmux -S "$socket" send-keys -t pi-verify C-u
tmux -S "$socket" send-keys -t pi-verify -l '/settings'
tmux -S "$socket" send-keys -t pi-verify Enter
wait_screen 03-settings 'Auto-compact'
print -r -- 'settings.resize: resize the terminal to 54 columns and 18 rows' >> "$evidence/actions.txt"
tmux -S "$socket" resize-window -t pi-verify -x 54 -y 18
wait_screen 04-narrow 'Auto-compact'
tmux -S "$socket" display-message -p -t pi-verify '#{window_width}x#{window_height}' > "$evidence/dimensions.txt"
rg -Fxq -- '54x18' "$evidence/dimensions.txt"
if rg -Fq -- 'Cache warming' "$evidence/04-narrow.txt"; then
	print -u2 'Narrow viewport already shows the scroll target'
	exit 1
fi
print -r -- 'settings.scroll: press Down until Cache warming is selected' >> "$evidence/actions.txt"
for attempt in {1..40}; do
	tmux -S "$socket" capture-pane -p -t pi-verify > "$evidence/05-scroll.txt"
	if rg -q -- '^→ Cache warming' "$evidence/05-scroll.txt"; then
		break
	fi
	tmux -S "$socket" send-keys -t pi-verify Down
	sleep 0.1
done
rg -q -- '^→ Cache warming' "$evidence/05-scroll.txt"
if rg -Fq -- 'Auto-compact' "$evidence/05-scroll.txt"; then
	print -u2 'Scroll failed: initial item remains visible'
	exit 1
fi

print -r -- 'settings.cancel: Escape, then type literal pi-verify-after-cancel without Enter' >> "$evidence/actions.txt"
tmux -S "$socket" send-keys -t pi-verify Escape
for attempt in {1..100}; do
	tmux -S "$socket" capture-pane -p -t pi-verify > "$evidence/05-dismiss.txt"
	if ! rg -Fq -- 'Cache warming' "$evidence/05-dismiss.txt"; then
		break
	fi
	sleep 0.1
done
if rg -Fq -- 'Cache warming' "$evidence/05-dismiss.txt"; then
	print -u2 'Settings cancel failed: scroll target remains visible'
	exit 1
fi
tmux -S "$socket" send-keys -t pi-verify -l 'pi-verify-after-cancel'
wait_screen 06-cancel 'pi-verify-after-cancel'
if rg -Fq -- 'Cache warming' "$evidence/06-cancel.txt"; then
	print -u2 'Editor focus failed: settings remain visible'
	exit 1
fi
print -r -- 'quit: Ctrl+U, restore the terminal size, then /quit and Enter' >> "$evidence/actions.txt"
tmux -S "$socket" send-keys -t pi-verify C-u
tmux -S "$socket" resize-window -t pi-verify -x 120 -y 32
tmux -S "$socket" send-keys -t pi-verify -l '/quit'
tmux -S "$socket" send-keys -t pi-verify Enter
for attempt in {1..100}; do
	[[ "$(tmux -S "$socket" display-message -p -t pi-verify '#{pane_dead}')" == 1 ]] && break
	sleep 0.1
done
tmux -S "$socket" display-message -p -t pi-verify '#{pane_dead} #{pane_dead_status}' > "$evidence/app-exit.txt"
rg -Fxq -- '1 0' "$evidence/app-exit.txt"
fd --hidden --type f . "$work/sessions" > "$evidence/session-files.txt"
[[ ! -s "$evidence/session-files.txt" ]]
git -C "$repo" rev-parse HEAD > "$evidence/revision-after.txt"
git -C "$repo" status --porcelain=v1 > "$evidence/worktree-after.txt"
cmp "$evidence/revision-before.txt" "$evidence/revision-after.txt"
cmp "$evidence/worktree-before.txt" "$evidence/worktree-after.txt"
[[ -s "$evidence/terminal.ansi" ]]
print -r -- 'PASS: CLI help/version, draft clearing, settings scroll/resize/cancel, clean quit, unchanged source and no session files' > "$evidence/result.txt"
print -r -- "$evidence"
