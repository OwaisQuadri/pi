#!/bin/zsh
set -euo pipefail

root=${0:A:h}
package_root=${PI_PACKAGE_ROOT:-$HOME/.pi-host/releases/342B7ED5-1529-45B0-A0B4-711AB31AD600/consumer/node_modules/@earendil-works/pi-coding-agent}
module=$package_root/dist/core/session-manager.js
[[ -f "$module" ]] || { print -u2 "Pi session manager not found. Set PI_PACKAGE_ROOT to the installed package."; exit 1; }
command -v swiftc >/dev/null || { print -u2 "swiftc is required"; exit 1; }
command -v node >/dev/null || { print -u2 "node is required"; exit 1; }
output=${TMPDIR:-/tmp}/pi-native-session-loader-swift-$$
trap 'rm -f -- "$output"' EXIT
swiftc -O -warnings-as-errors "$root/main.swift" -o "$output"
node "$root/suite.mjs" swift "$output" "$module" "${PI_SESSION_FILE:-}"
