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

The real-session driver checks the entry count and the `text` byte count of the first content element for each mode. The raw-line mode parses entries to check them, but retains their original JSON text and identifiers instead of parsed objects. It does not implement Pi's branch selection, context projection, or extension calls. It trades parsing and data access time for lower retained memory. On successful runs, the script checks that the source file size did not change and does not print its path or content. Node.js may include the path in a file-access error. Child error output is not forwarded, so session content is not printed on parse failure. Its summed resident sets can double-count shared pages. A larger session, real Pi startup, extensions, peak memory, and concurrent sessions remain unmeasured.

## Eightfold whole-session target

A live Pi process on the development Mac had 2,215,008 KiB resident in `ps`. An eightfold reduction from **that exact baseline** would require no more than 276,876 KiB for the complete replacement, including the TypeScript extension host and native workers. A second `vmmap -summary` sample showed 1.7 GB resident in application tag 16, 3.0 GB physical footprint, and 9.9 GB peak physical footprint. The operating system tag does not identify the allocation owner, so neither sample proves that session history caused this footprint.

A separate exploratory startup probe loaded a 26,943,043-byte session. An empty Pi process used 144,320 KiB resident in one run, and the same session without extensions used 234,752 KiB. An attempt to measure configured extensions was inconclusive: on some starts they registered 51 commands; on others Pi emitted only status, widget, and notification requests and did not answer a state query within 120 seconds. Extension startup hooks can have side effects, and the probe did not include extension subprocesses or active-turn memory. Its script is not a supported benchmark and is not part of this experiment. These idle samples cannot be compared with the long-lived 2 GB process.

An eightfold **working-session** proof needs two complete implementations on the same workload and device. First profile the long-lived allocation owner. Then build a bounded, controlled benchmark with a copied session and an explicitly selected extension set. Keep the same model, extensions, tools, session contents, prompts, active-turn state, and number of concurrent sessions. Count successful responses and matching tool and extension effects. Alternate at least five runs per implementation; compare peak and settled aggregate memory of the runner and its descendants, not just a parser or an idle process. A production design needs full session branching and projection semantics plus a message exchange with the TypeScript extension host. The current experiment does not establish the eightfold target or an improvement from moving other components.

A separate compiled session server can exchange JSON lines with a JavaScript extension host. This small probe executes a TypeScript extension on an entry requested by identifier from Rust:

```sh
node experiments/native-session-memory/extension-host.mjs /tmp/pi-native-session-memory-target/release/native-session-memory experiments/native-session-memory/sample.jsonl 1
```

It printed `EXTENSION_OK 1:user` with Node.js 26.5.1. This is not an existing Pi extension: the probe uses a single pure function and Node's built-in TypeScript type stripping, not Pi's `jiti` extension loader or its full application programming interface. The session server returns whole entries, so copied data can erase the savings if extensions request many large entries. No whole-session memory result or latency has been measured for this bridge.

Third-party TypeScript extensions currently depend on Pi's in-process JavaScript application programming interface. An automatic TypeScript-to-Rust or TypeScript-to-Swift transpiler cannot preserve arbitrary JavaScript behavior. To keep existing extensions, retain a JavaScript host and introduce a versioned protocol at the native boundary. Measure its copies, latency, and memory cost before moving session state or other runner components. Existing synchronous extension calls may need direct host ownership or a revised interface; this experiment does not solve that compatibility problem.
