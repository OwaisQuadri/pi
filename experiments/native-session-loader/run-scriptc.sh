#!/bin/zsh
set -euo pipefail

root=${0:A:h}
package_root=${PI_PACKAGE_ROOT:-$HOME/.pi-host/current/consumer/node_modules/@earendil-works/pi-coding-agent}
module=$package_root/dist/core/session-manager.js
[[ -f "$module" ]] || { print -u2 "Pi session manager not found. Set PI_PACKAGE_ROOT to the installed package."; exit 1; }
compiler=${SCRIPTC_BIN:-scriptc}
command -v "$compiler" >/dev/null || { print -u2 "scriptc is required. Set SCRIPTC_BIN to its executable path."; exit 1; }
command -v node >/dev/null || { print -u2 "node is required"; exit 1; }
temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/pi-native-session-loader-scriptc-XXXXXXXX")
trap 'rm -rf -- "$temporary_directory"' EXIT
output=$temporary_directory/session-loader
"$compiler" build "$root/scriptc-session-loader.ts" -o "$output" --optimization release --no-keep-llvm
node "$root/suite.mjs" scriptc "$output" "$module" "${PI_SESSION_FILE:-}"
