import { spawn } from "node:child_process";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [kind, fixture, modulePath, binary] = process.argv.slice(2);
const size = statSync(fixture).size;
if (!size) throw new Error("Session file is empty");
const fd = openSync(fixture, "r");
const lastByte = Buffer.alloc(1);
readSync(fd, lastByte, 0, 1, size - 1);
closeSync(fd);
if (lastByte[0] !== 10) throw new Error("Refusing to benchmark a session that the installed loader would modify");
const { loadEntriesFromFile } = await import(pathToFileURL(modulePath).href);
let entries;
let worker;
let stopped;
if (kind === "node") {
  entries = loadEntriesFromFile(fixture);
  const bytes = entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.message?.content?.[0]?.text ?? ""), 0);
  globalThis.__retainedEntries = entries;
  console.log(`READY ${entries.length} ${bytes} 0`);
} else {
  worker = spawn(binary, [fixture], { stdio: ["ignore", "pipe", "inherit"] });
  stopped = new Promise((resolve, reject) => {
    worker.once("exit", resolve);
    worker.once("error", reject);
  });
  const output = await new Promise((resolve, reject) => {
    worker.stdout.once("data", (chunk) => resolve(String(chunk).trim()));
    stopped.then((code) => reject(new Error(`${kind} exited ${code} before ready`)), reject);
  });
  console.log(`${output} ${worker.pid}`);
}
await new Promise((resolve) => setTimeout(resolve, 1500));
if (worker) {
  const code = await stopped;
  if (code !== 0) throw new Error(`${kind} exited ${code}`);
}
if (entries) {
  if (globalThis.__retainedEntries !== entries) throw new Error("Entries were released");
}
