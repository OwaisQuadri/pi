#!/bin/zsh
set -euo pipefail

root=${0:A:h}
package_root=${PI_PACKAGE_ROOT:-$HOME/.pi-host/releases/342B7ED5-1529-45B0-A0B4-711AB31AD600/consumer/node_modules/@earendil-works/pi-coding-agent}
module=$package_root/dist/core/session-manager.js
[[ -f "$module" ]] || { print -u2 "Pi session manager not found. Set PI_PACKAGE_ROOT to the installed package."; exit 1; }
command -v cargo >/dev/null || { print -u2 "cargo is required"; exit 1; }
command -v node >/dev/null || { print -u2 "node is required"; exit 1; }
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-${TMPDIR:-/tmp}/pi-native-session-loader-target}
cargo build --release --locked --manifest-path "$root/Cargo.toml"
node "$root/suite.mjs" rust "$CARGO_TARGET_DIR/release/native-session-loader" "$module" "${PI_SESSION_FILE:-}"
