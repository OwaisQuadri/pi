import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";

const [kind, fixture, binary] = process.argv.slice(2);
let entries;
let worker;
let exited;
if (kind === "node") {
  entries = [];
  let bytes = 0;
  for await (const line of createInterface({ input: createReadStream(fixture) })) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    bytes += Buffer.byteLength(entry.message?.content?.[0]?.text ?? "");
    entries.push(entry);
  }
  console.log(`READY ${entries.length} ${bytes} 0`);
} else if (kind === "rust-generic" || kind === "rust-typed" || kind === "rust-lazy") {
  worker = spawn(binary, [fixture, kind.slice(5)], { stdio: ["ignore", "pipe", "inherit"] });
  exited = new Promise((resolve) => worker.once("exit", resolve));
  const output = await new Promise((resolve, reject) => {
    const lines = createInterface({ input: worker.stdout });
    lines.once("line", (line) => { lines.close(); resolve(line); });
    worker.once("error", reject);
    worker.once("exit", (code) => reject(new Error(`Rust worker exited ${code} before ready`)));
  });
  console.log(`${output} ${worker.pid}`);
} else {
  throw new Error(`Unknown mode ${kind}`);
}
await new Promise((resolve) => setTimeout(resolve, 1500));
if (worker) {
  const code = await exited;
  if (code !== 0) throw new Error(`Rust worker exited ${code}`);
}
if (entries && entries.length < 1) throw new Error("No entries retained");
