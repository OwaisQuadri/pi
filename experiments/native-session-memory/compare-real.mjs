import { spawn, execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const [binary, fixture] = process.argv.slice(2);
if (!binary || !fixture) throw new Error("Expected release binary and existing session path");
const size = statSync(fixture).size;
const results = { node: [], "rust-generic": [], "rust-lazy": [] };
let expected;
for (let round = 0; round < 5; round++) {
  for (const kind of round % 2 ? ["rust-lazy", "rust-generic", "node"] : ["node", "rust-generic", "rust-lazy"]) {
    const child = spawn(process.execPath, [join(directory, "session-node.mjs"), kind, fixture, binary], { stdio: ["ignore", "pipe", "ignore"] });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    while (!stdout.includes("\n") && child.exitCode === null && child.signalCode === null) await new Promise((resolve) => setTimeout(resolve, 20));
    const [ready, count, bytes, worker] = stdout.trim().split(" ");
    if (ready !== "READY" || !Number.isInteger(Number(count)) || !Number.isInteger(Number(bytes))) throw new Error(`${kind} failed to load session`);
    const value = `${count} ${bytes}`;
    if (!expected) expected = value;
    if (expected !== value) throw new Error(`${kind} produced ${value}; expected ${expected}`);
    const pids = Number(worker) ? [child.pid, Number(worker)] : [child.pid];
    const rssKiB = pids.reduce((sum, pid) => sum + Number(execFileSync("ps", ["-p", String(pid), "-o", "rss="], { encoding: "utf8" }).trim()), 0);
    const exitCode = await exited;
    if (exitCode !== 0) throw new Error(`${kind} exited ${exitCode}`);
    results[kind].push(rssKiB);
    console.log(`${kind} round=${round + 1} aggregate_resident_kib=${rssKiB}`);
  }
}
if (statSync(fixture).size !== size) throw new Error("Session changed during benchmark");
for (const [kind, samples] of Object.entries(results)) {
  const sorted = samples.toSorted((left, right) => left - right);
  console.log(`${kind} aggregate_median_kib=${sorted[2]} range_kib=${sorted[0]}..${sorted[4]}`);
}
console.log(`session_bytes=${size} parsed_entries_and_text_bytes=${expected}`);
