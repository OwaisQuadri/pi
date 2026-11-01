# Native Pi session-loader comparison

These suites compare one extracted session-loading path with the installed Pi `loadEntriesFromFile` function. Each suite runs the JavaScript loader in a Node.js worker and the native loader in a compiled worker. The Node.js host receives only a summary in both modes; its memory is excluded from the comparison. These suites do not replace Pi's runner or test third-party extensions.

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

Run the separate scriptc experiment with a local scriptc 0.4.7 compiler:

```zsh
SCRIPTC_BIN='/path/to/scriptc' ./experiments/native-session-loader/run-scriptc.sh
```

The scriptc command builds `scriptc-session-loader.ts` as a native executable and runs the same correctness and worker-only memory comparison against the installed Pi loader. It reads the whole file before parsing, unlike Pi's streaming loader, so memory results measure this implementation rather than an optimized port. The combined command still runs only Rust, Swift, and Zig. This prototype does not compile Pi's runner or any extension. A source revision hash identifies extension source; it does not replace a built extension or let the runner load one. No extension source is removed.

Install Node.js, Rust with Cargo, a Swift compiler, and Zig before running all three. Each wrapper checks its own compiler. The wrappers use the current local Pi installation at `~/.pi-host/current`. Set `PI_PACKAGE_ROOT` to the installed Pi package directory on a different layout.

By default, each suite creates a separate, deterministic session file with 40,000 messages and 40,960,000 bytes of distinct text. To use the **same existing session file** for all suites, set `PI_SESSION_FILE`:

```zsh
PI_SESSION_FILE='/path/to/session.jsonl' ./experiments/native-session-loader/run-all.sh
```

The combined command copies the supplied file once, and each suite measures its own copy of that snapshot. An individual suite also copies a supplied file before loading it. None of the loaders edits the source file. A snapshot without a final newline is refused because Pi's installed loader could add one. Use a closed session for stable results. Do not share real session contents in benchmark output or a pull request.

Each of Rust, Swift, and Zig runs shared correctness cases and one language-specific case. The optional scriptc suite runs the shared cases. A failing case makes that suite fail. It then takes five alternating samples of the installed JavaScript worker and the native worker. The output gives message count, retained text bytes, host and worker resident set size (RSS) in kibibytes (KiB), startup time in milliseconds, worker-only medians, ranges, and a worker-only ratio. Compilation time is not part of the measurements. The combined command attempts all three suites and exits with a failure status if any fails.

**Limit:** Worker RSS can include shared pages. It samples memory after the loader reports ready; it does not measure peak memory, active Pi sessions, model context handling, tools, or the full extension interface. Both workers retain parsed entries, but the Node host receives only a count and byte total. It cannot yet use either worker's entries as a session loader. Even a worker-only ratio of eight or more does **not** prove the separate goal of eightfold lower memory for a complete working Pi session.
