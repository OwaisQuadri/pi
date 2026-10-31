# Native Pi session-loader comparison

These suites compare one extracted session-loading path with the installed Pi `loadEntriesFromFile` function. Each suite uses the same Node.js host to load Pi's JavaScript module and, for the native option, a separate compiled worker. They do not replace Pi's runner or test third-party extensions.

Run from the repository root:

```zsh
./experiments/native-session-loader/run-all.sh
```

Run one language:

```zsh
./experiments/native-session-loader/run-rust.sh
./experiments/native-session-loader/run-swift.sh
./experiments/native-session-loader/run-zig.sh
```

Install Node.js, Rust with Cargo, a Swift compiler, and Zig before running all three. Each wrapper checks its own compiler. Set `PI_PACKAGE_ROOT` to the installed Pi package directory if it differs from the default in the wrappers.

By default, each suite creates a separate, deterministic session file with 40,000 messages and 40,960,000 bytes of distinct text. To use the **same existing session file** for all suites, set `PI_SESSION_FILE`:

```zsh
PI_SESSION_FILE='/path/to/session.jsonl' ./experiments/native-session-loader/run-all.sh
```

The suite reads that file but does not edit it. It refuses a file without a final newline because Pi's installed loader could add one. Avoid sharing real session contents in benchmark output or a pull request.

Each language runs shared correctness cases and one language-specific case. A failing case makes that suite fail. It then takes five alternating samples of the installed JavaScript loader and the native option. The output gives message count, retained text bytes, Node host and worker resident set size (RSS) in kibibytes (KiB), startup time in milliseconds, medians, ranges, and a ratio. Compilation time is not part of the measurements. The combined command attempts all three suites and exits with a failure status if any fails.

**Limit:** RSS sums the two processes and can count shared pages twice. It samples memory after the loader reports ready; it does not measure peak memory, active Pi sessions, model context handling, tools, or the full extension interface. A loader-level ratio of eight or more does **not** prove the separate goal of eightfold lower memory for a complete working Pi session.
