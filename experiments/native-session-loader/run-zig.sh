#!/bin/zsh
set -euo pipefail

root=${0:A:h}
package_root=${PI_PACKAGE_ROOT:-$HOME/.pi-host/releases/342B7ED5-1529-45B0-A0B4-711AB31AD600/consumer/node_modules/@earendil-works/pi-coding-agent}
module=$package_root/dist/core/session-manager.js
[[ -f "$module" ]] || { print -u2 "Pi session manager not found. Set PI_PACKAGE_ROOT to the installed package."; exit 1; }
command -v zig >/dev/null || { print -u2 "zig is required"; exit 1; }
command -v node >/dev/null || { print -u2 "node is required"; exit 1; }
output=${TMPDIR:-/tmp}/pi-native-session-loader-zig-$$
trap 'rm -f -- "$output"' EXIT
zig build-exe "$root/main.zig" -O ReleaseFast -lc -femit-bin="$output"
node "$root/suite.mjs" zig "$output" "$module" "${PI_SESSION_FILE:-}"
