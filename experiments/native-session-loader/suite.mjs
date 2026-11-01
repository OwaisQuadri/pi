import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, createWriteStream, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const [kind, binary, modulePath, suppliedSession] = process.argv.slice(2);
if (!["rust", "swift", "zig", "scriptc"].includes(kind)) throw new Error("Expected rust, swift, zig, or scriptc");
const root = dirname(fileURLToPath(import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "pi-session-loader-suite-"));
const ownedFiles = [];

function fixture(name, content) {
  const path = join(directory, name);
  writeFileSync(path, content);
  ownedFiles.push(path);
  return path;
}

async function largeFixture() {
  const path = join(directory, "large.jsonl");
  ownedFiles.push(path);
  const output = createWriteStream(path);
  output.write('{"type":"session","id":"memory-fixture"}\n');
  const prefix = "x".repeat(1018);
  for (let index = 0; index < 40000; index++) {
    const text = prefix + String(index).padStart(6, "0");
    const row = JSON.stringify({ type: "message", id: String(index), parentId: index ? String(index - 1) : null, message: { role: "user", content: [{ type: "text", text }] } }) + "\n";
    if (!output.write(row)) await once(output, "drain");
  }
  output.end();
  await once(output, "finish");
  return path;
}

function residentKiB(pid) {
  const value = Number(execFileSync("ps", ["-p", String(pid), "-o", "rss="], { encoding: "utf8" }).trim());
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Could not measure process ${pid}`);
  return value;
}

async function sample(mode, path) {
  const started = performance.now();
  const child = spawn(process.execPath, [join(root, "reference.mjs"), mode, path, modulePath, binary], { stdio: ["ignore", "pipe", "pipe"], detached: true });
  let stderr = "";
  let stdout = "";
  child.stderr.on("data", (data) => { stderr += String(data).slice(0, 4096); });
  const exit = new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  child.stdout.on("data", (data) => {
    stdout += String(data);
    if (stdout.length > 4096) rejectReady(new Error("Unexpectedly large output"));
    if (stdout.includes("\n")) resolveReady(stdout.split("\n", 1)[0]);
  });
  child.once("exit", () => { if (!stdout.includes("\n")) rejectReady(new Error(`No ready output; exit: ${stderr}`)); });
  let rejectTimeout;
  const deadline = new Promise((_, reject) => { rejectTimeout = reject; });
  const timeout = setTimeout(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    rejectTimeout(new Error(`Timed out running ${mode}: ${stderr}`));
  }, 30000);
  try {
    const line = await Promise.race([ready, deadline]);
    const match = /^READY (\d+) (\d+) (\d+)$/.exec(line);
    if (!match) throw new Error(`Invalid ${mode} output: ${line}`);
    const readyMs = performance.now() - started;
    const workerPid = Number(match[3]);
    const hostKiB = residentKiB(child.pid);
    const workerKiB = workerPid ? residentKiB(workerPid) : 0;
    const result = await Promise.race([exit, deadline]);
    if (result.code !== 0) throw new Error(`${mode} exited ${result.code} (${result.signal ?? "no signal"}): ${stderr}`);
    return { count: Number(match[1]), bytes: Number(match[2]), hostKiB, workerKiB, aggregateKiB: hostKiB + workerKiB, readyMs };
  } catch (error) {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function median(values) {
  return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
}

function range(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return `${sorted[0]}–${sorted.at(-1)}`;
}

try {
  const cases = [
    ["valid, malformed, blank, Unicode", fixture("valid.jsonl", '{"type":"session","id":"fixture"}\n{"type":"message","message":{"content":[{"type":"text","text":"hello"}]}}\ninvalid json\n\n{"type":"message","message":{"content":[{"type":"text","text":"🌙"}]}}\n'), 3, 9],
    ["invalid header", fixture("bad-header.jsonl", '{"type":"message","id":"wrong"}\n{"type":"session","id":"late"}\n'), 0, 0],
    ["parsed scalar before header", fixture("scalar.jsonl", '7\n{"type":"session","id":"late"}\n'), 0, 0],
    ["falsey values after header", fixture("falsey.jsonl", '{"type":"session","id":"fixture"}\nnull\nfalse\n0\n""\n{"type":"message","message":{"content":[{"type":"text","text":"ok"}]}}\n'), 2, 2],
  ];
  if (kind === "rust") {
    const text = "x".repeat(70000);
    cases.push(["Rust buffered read over 64 KiB", fixture("rust-long.jsonl", `{"type":"session","id":"fixture"}\n${JSON.stringify({ type: "message", message: { content: [{ type: "text", text }] } })}\n`), 2, text.length]);
  } else if (kind === "swift") {
    const header = '{"type":"session","id":"fixture"}\n';
    const prefix = '{"type":"message","message":{"content":[{"type":"text","text":"';
    const padding = (32766 - ((header.length + prefix.length) % 32768) + 32768) % 32768;
    const text = "x".repeat(padding) + "🌙";
    cases.push(["Swift multibyte character across a read boundary", fixture("swift-boundary.jsonl", `${header}${prefix}${text}` + '"}]}}\n'), 2, padding + 4]);
  } else if (kind === "zig") {
    cases.push(["Zig CRLF session lines", fixture("zig-crlf.jsonl", '{"type":"session","id":"fixture"}\r\n{"type":"message","message":{"content":[{"type":"text","text":"a"}]}}\r\n{"type":"message","message":{"content":[{"type":"text","text":"é"}]}}\r\n'), 3, 3]);
  }
  let failures = 0;
  for (const [name, path, expectedCount, expectedBytes] of cases) {
    const baseline = await sample("node", path);
    const candidate = await sample(kind, path);
    const passed = baseline.count === expectedCount && baseline.bytes === expectedBytes && candidate.count === expectedCount && candidate.bytes === expectedBytes;
    console.log(`${passed ? "PASS" : "FAIL"} ${kind}: ${name} (JavaScript ${baseline.count}/${baseline.bytes}, native ${candidate.count}/${candidate.bytes})`);
    if (!passed) failures++;
  }
  if (failures) throw new Error(`${failures} correctness case(s) disagreed with the installed Pi loader`);

  let workload;
  if (suppliedSession) {
    workload = join(directory, "supplied-snapshot.jsonl");
    copyFileSync(suppliedSession, workload);
    ownedFiles.push(workload);
  } else {
    workload = await largeFixture();
  }
  console.log(suppliedSession ? "Workload: snapshot of supplied session file (source untouched)" : "Workload: 40,000 messages, 40,960,000 text bytes (synthetic)");
  const samples = { "node-worker": [], [kind]: [] };
  for (let round = 0; round < 5; round++) {
    const order = round % 2 ? [kind, "node-worker"] : ["node-worker", kind];
    for (const mode of order) {
      const result = await sample(mode, workload);
      samples[mode].push(result);
      console.log(`round=${round + 1} ${mode} count=${result.count} text_bytes=${result.bytes} host_KiB=${result.hostKiB} worker_KiB=${result.workerKiB} aggregate_RSS_KiB=${result.aggregateKiB} ready_ms=${result.readyMs.toFixed(0)}`);
    }
    const [baseline, candidate] = [samples["node-worker"].at(-1), samples[kind].at(-1)];
    if (!baseline.count || !baseline.bytes) throw new Error("Workload contained no retained message text");
    if (baseline.count !== candidate.count || baseline.bytes !== candidate.bytes) throw new Error(`Round ${round + 1} results disagree`);
  }
  console.log("\n| Worker | Samples | Median worker RSS KiB | Range KiB | Median ready ms | Range ms |");
  console.log("|---|---:|---:|---:|---:|---:|");
  for (const mode of ["node-worker", kind]) {
    const values = samples[mode];
    console.log(`| ${mode} | ${values.length} | ${median(values.map((entry) => entry.workerKiB))} | ${range(values.map((entry) => entry.workerKiB))} | ${median(values.map((entry) => Math.round(entry.readyMs)))} | ${range(values.map((entry) => Math.round(entry.readyMs)))} |`);
  }
  const factor = median(samples["node-worker"].map((entry) => entry.workerKiB)) / median(samples[kind].map((entry) => entry.workerKiB));
  console.log(`Worker memory ratio: ${factor.toFixed(2)}× (JavaScript / ${kind}; host excluded)`);
  console.log("Both workers retain their parsed entries; the Node host holds only a summary. This is not a functional loader replacement.");
  console.log("All outputs agreed; 0 failed cases; build time excluded. Worker RSS can include shared pages. This does not measure an entire Pi session or prove its 8× goal.");
} finally {
  for (const path of ownedFiles) unlinkSync(path);
  rmdirSync(directory);
}
