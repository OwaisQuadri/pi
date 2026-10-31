import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import inspectEntry from "./extension.ts";

const [binary, fixture, id] = process.argv.slice(2);
if (!binary || !fixture || !id) throw new Error("Expected native binary, session file, and entry ID");
const worker = spawn(binary, [fixture, "serve"], { stdio: ["pipe", "pipe", "inherit"] });
const exited = new Promise((resolve) => worker.once("exit", (code, signal) => resolve({ code, signal })));
const lines = createInterface({ input: worker.stdout })[Symbol.asyncIterator]();
try {
  const ready = await lines.next();
  if (!ready.value?.startsWith("READY ")) throw new Error("Native session server did not start");
  worker.stdin.write(`${JSON.stringify({ id })}\n`);
  const reply = await lines.next();
  if (reply.done) throw new Error("Native session server closed before reply");
  const entry = JSON.parse(reply.value);
  if (!entry || entry.id !== id) throw new Error("Native session server returned the wrong entry");
  const result = inspectEntry(entry);
  console.log(`EXTENSION_OK ${result}`);
} finally {
  worker.stdin.end();
  const { code, signal } = await exited;
  if (code !== 0 || signal) throw new Error(`Native session server exited ${signal ?? code}`);
}
