#!/bin/zsh
set -euo pipefail

root=${0:A:h}
failed=0
for language in rust swift zig; do
    print "\n=== $language session-loader suite ==="
    if "$root/run-$language.sh"; then
        print "$language: PASS"
    else
        print -u2 "$language: FAIL"
        failed=1
    fi
done
print "\nAll three suites attempted. The numbers measure the session loader, not an entire Pi session."
exit "$failed"
