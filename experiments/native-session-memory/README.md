# Native session-memory experiment

This experiment tests one part of a compiled Pi: retaining session entries while a JavaScript runtime remains available for TypeScript extensions. It does not replace Pi or implement Pi's extension interface.

On macOS, with Node.js and Rust installed:

```sh
CARGO_TARGET_DIR=/tmp/pi-native-session-memory-target cargo build --release --offline --manifest-path experiments/native-session-memory/Cargo.toml
node experiments/native-session-memory/compare.mjs /tmp/pi-native-session-memory-target/release/native-session-memory
```

The driver writes a new 40,000-line, roughly 47 MB synthetic session file under the system temporary directory. Each message has a 1,024-byte text part, an identifier, a parent identifier, and a role. It starts each option five times, alternates the order, checks entry and text-byte counts, samples resident memory after loading, and reports the median and range. `node` retains parsed objects in one Node.js process. Each Rust option keeps a Node.js host process alive to stand in for the extension runtime; their reported memory is the sum of the host and worker resident sets. `rust-generic` retains `serde_json::Value` trees; `rust-typed` retains typed entries. The driver prints the fixture path and does not remove it. Resident-set sums can count shared pages twice and do not measure peak memory.

One run on the development Mac (five samples per option, KiB):

| Option | Median aggregate resident | Range |
| --- | ---: | ---: |
| Node.js | 168,432 | 165,760–169,216 |
| Rust generic | 181,216 | 181,088–181,616 |
| Rust typed | 106,896 | 106,816–106,944 |

The typed Rust option used 36.5% less aggregate resident memory than Node.js **in this synthetic workload**. The generic Rust option used 7.6% more. Data representation, not compilation alone, accounts for the difference.

To measure a closed, real Pi session without copying or changing its file, run:

```sh
node experiments/native-session-memory/compare-real.mjs /tmp/pi-native-session-memory-target/release/native-session-memory '<session.jsonl>'
```

On one 26,943,043-byte session with 3,229 entries, five runs per option yielded these aggregate resident results (KiB):

| Option | Median | Range |
| --- | ---: | ---: |
| Node.js parsed objects | 149,376 | 128,832–149,696 |
| Rust parsed objects | 100,384 | 100,352–100,928 |
| Rust raw lines with entry identifiers | 85,456 | 84,704–85,760 |

The real-session driver checks the entry count and first text-part byte count for each mode. The raw-line mode parses entries to check them, but retains their original JSON text and identifiers instead of parsed objects. It does not implement Pi's branch selection, context projection, or extension calls. It trades parsing and data access time for lower retained memory. On successful runs, the script checks that the source file size did not change and does not print its path or content. Node.js may include the path in an error message. Its summed resident sets can double-count shared pages. A larger session, real Pi startup, extensions, peak memory, and concurrent sessions remain unmeasured.

A live Pi process on the same Mac had 2,215,008 KiB resident in `ps`; `vmmap -summary` attributed about 1.7 GB resident to application tag 16. This does not identify the objects or prove that session history caused the footprint. A production design needs session branching and projection semantics plus a message exchange with the TypeScript extension host. These experiments do not show a reduction in a 2 GB Pi session or prove that moving other components helps. Before migrating a component, compare full-process memory for the same real workflow, with extensions enabled and disabled, and require a reproducible aggregate-memory improvement without behavior loss.

A separate compiled session server can exchange JSON lines with a JavaScript extension host. This small probe executes a TypeScript extension on an entry requested by identifier from Rust:

```sh
node experiments/native-session-memory/extension-host.mjs /tmp/pi-native-session-memory-target/release/native-session-memory experiments/native-session-memory/sample.jsonl 1
```

It printed `EXTENSION_OK 1:user` with Node.js 26.5.1. This is not an existing Pi extension: the probe uses a single pure function and Node's built-in TypeScript type stripping, not Pi's `jiti` extension loader or its full application programming interface. The session server returns whole entries, so copied data can erase the savings if extensions request many large entries. No whole-session memory result or latency has been measured for this bridge.

Third-party TypeScript extensions currently depend on Pi's in-process JavaScript application programming interface. An automatic TypeScript-to-Rust or TypeScript-to-Swift transpiler cannot preserve arbitrary JavaScript behavior. To keep existing extensions, retain a JavaScript host and introduce a versioned protocol at the native boundary. Measure its copies, latency, and memory cost before moving session state or other runner components. Existing synchronous extension calls may need direct host ownership or a revised interface; this experiment does not solve that compatibility problem.
