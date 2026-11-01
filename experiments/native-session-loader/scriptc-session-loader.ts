import { readFileSync } from "node:fs";

function loadEntriesFromFile(filePath: string): unknown[] {
	const entries: unknown[] = [];
	for (const line of readFileSync(filePath, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as unknown;
			if (entry) entries.push(entry);
		} catch {}
	}
	if (entries.length === 0) return entries;
	const header = entries[0] as { type?: string; id?: unknown };
	if (header.type !== "session" || typeof header.id !== "string") return [];
	return entries;
}

const filePath = process.argv[2];
if (!filePath) throw new Error("usage: scriptc-session-loader <session.jsonl>");
const entries = loadEntriesFromFile(filePath);
let bytes = 0;
for (const entry of entries) {
	const text = (entry as { message?: { content?: Array<{ text?: string }> } }).message?.content?.[0]?.text;
	if (text) bytes += Buffer.byteLength(text);
}
console.log(`READY ${entries.length} ${bytes}`);
await new Promise<void>((resolve) => setTimeout(resolve, 1500));
let retainedCount = 0;
for (const entry of entries) {
	if (typeof (entry as { type?: unknown }).type === "string") retainedCount++;
}
console.log(`RETAINED ${retainedCount}`);
