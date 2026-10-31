import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const binary = process.argv[2];
if (!binary) throw new Error("Pass the release Rust binary path");
const fixture = join(tmpdir(), `pi-native-session-memory-${process.pid}.jsonl`);
const output = createWriteStream(fixture);
const rows = 40000;
const payload = "x".repeat(1024);
for (let index = 0; index < rows; index++) {
  const line = JSON.stringify({ type: "message", id: String(index), parentId: index ? String(index - 1) : null, message: { role: "user", content: [{ type: "text", text: payload }] } }) + "\n";
  if (!output.write(line)) await once(output, "drain");
}
output.end();
await once(output, "finish");

const results = { node: [], "rust-generic": [], "rust-typed": [] };
for (let round = 0; round < 5; round++) {
  for (const kind of round % 2 ? ["rust-typed", "rust-generic", "node"] : ["node", "rust-generic", "rust-typed"]) {
    const child = spawn(process.execPath, [join(directory, "session-node.mjs"), kind, fixture, binary], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    while (!stdout.includes("\n") && child.exitCode === null && child.signalCode === null) await new Promise((resolve) => setTimeout(resolve, 20));
    const expected = `READY ${rows} ${rows * payload.length}`;
    const [actual, workerPid] = [stdout.trim().split(" ").slice(0, 3).join(" "), Number(stdout.trim().split(" ")[3])];
    if (actual !== expected || !Number.isInteger(workerPid)) throw new Error(`${kind} output ${stdout.trim()} != ${expected}; ${stderr}`);
    const pids = workerPid ? [child.pid, workerPid] : [child.pid];
    const rssKiB = pids.reduce((sum, pid) => sum + Number(execFileSync("ps", ["-p", String(pid), "-o", "rss="], { encoding: "utf8" }).trim()), 0);
    const exitCode = await exited;
    if (exitCode !== 0) throw new Error(`${kind} exited ${exitCode}: ${stderr}`);
    results[kind].push(rssKiB);
    console.log(`${kind} round=${round + 1} aggregate_resident_kib=${rssKiB}`);
  }
}
for (const [kind, samples] of Object.entries(results)) {
  const sorted = samples.toSorted((left, right) => left - right);
  console.log(`${kind} aggregate_median_kib=${sorted[2]} range_kib=${sorted[0]}..${sorted[4]}`);
}
console.log(`fixture=${fixture}`);
