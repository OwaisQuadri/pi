import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	preparePackage,
	readCompileCommand,
	recoverPackage,
	removePreparedPackage,
	runPackageCompile,
	withPackageLock,
} from "../src/core/package-compile.ts";

describe("managed package preparation", () => {
	let root: string;
	let target: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-package-compile-"));
		target = join(root, "package");
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("rejects malformed compile declarations rather than silently skipping compilation", () => {
		mkdirSync(target);
		for (const compile of [null, "node build.js", [], [""], ["node", 1]]) {
			writeFileSync(join(target, "package.json"), JSON.stringify({ pi: { compile } }));
			expect(() => readCompileCommand(target)).toThrow("pi.compile");
		}
		writeFileSync(join(target, "package.json"), JSON.stringify({ pi: { compile: ["node", "build.js"] } }));
		expect(readCompileCommand(target)).toEqual(["node", "build.js"]);
	});

	it("publishes only after compile success and preserves copied unknown files", async () => {
		mkdirSync(target);
		writeFileSync(join(target, "tool"), "old");
		writeFileSync(join(target, "private-note"), "keep");
		await withPackageLock(target, (assertHeld) =>
			preparePackage(
				target,
				async (stage, isExisting, run) => {
					expect(isExisting).toBe(true);
					expect(readFileSync(join(target, "tool"), "utf8")).toBe("old");
					writeFileSync(
						join(stage, "package.json"),
						JSON.stringify({ pi: { compile: ["/bin/sh", "-c", "printf new > tool"] } }),
					);
					await runPackageCompile(stage, run);
				},
				assertHeld,
			),
		);
		expect(readFileSync(join(target, "tool"), "utf8")).toBe("new");
		expect(readFileSync(join(target, "private-note"), "utf8")).toBe("keep");
	});

	it("keeps prepared command output out of protected stdout", () => {
		const script = join(root, "protected-output.mjs");
		writeFileSync(
			script,
			`import { mkdirSync } from "node:fs";
import { preparePackage, withPackageLock } from ${JSON.stringify(new URL("../src/core/package-compile.ts", import.meta.url).href)};
import { flushRawStdout, takeOverStdout, writeRawStdout } from ${JSON.stringify(new URL("../src/core/output-guard.ts", import.meta.url).href)};
takeOverStdout();
await withPackageLock(process.argv[2], (assertHeld) =>
	preparePackage(process.argv[2], async (stage, _isExisting, run) => {
		mkdirSync(stage);
		await run(process.execPath, ["-e", "process.stdout.write('prepared-output\\\\n')"]);
	}, assertHeld));
writeRawStdout("protocol-output\\n");
await flushRawStdout();
`,
		);
		const result = spawnSync(process.execPath, [script, target], { encoding: "utf8", timeout: 10_000 });
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe("protocol-output\n");
		expect(result.stderr).toContain("prepared-output\n");
	});

	it("keeps the working generation and permits a same-source retry after compile failure", async () => {
		mkdirSync(target);
		writeFileSync(join(target, "tool"), "old");
		await expect(
			withPackageLock(target, (assertHeld) =>
				preparePackage(
					target,
					async (_stage, _isExisting, run) => {
						await run("/bin/sh", ["-c", "printf broken > tool; exit 7"]);
					},
					assertHeld,
				),
			),
		).rejects.toThrow("code 7");
		expect(readFileSync(join(target, "tool"), "utf8")).toBe("old");
		await withPackageLock(target, (assertHeld) =>
			preparePackage(
				target,
				async (stage) => {
					writeFileSync(join(stage, "tool"), "repaired");
				},
				assertHeld,
			),
		);
		expect(readFileSync(join(target, "tool"), "utf8")).toBe("repaired");
	});

	it("removes only the unpublished candidate after a failed first install", async () => {
		await expect(
			withPackageLock(target, (assertHeld) =>
				preparePackage(
					target,
					async (stage) => {
						mkdirSync(stage);
						writeFileSync(join(stage, "partial"), "partial");
						throw new Error("dependency failure");
					},
					assertHeld,
				),
			),
		).rejects.toThrow("dependency failure");
		expect(existsSync(target)).toBe(false);
		expect(
			readdirSync(root, { withFileTypes: true }).filter(
				(entry) => entry.isDirectory() && entry.name.includes("pi-stage"),
			),
		).toEqual([]);
	});

	it("refuses publication when another writer changes the active generation", async () => {
		mkdirSync(target);
		writeFileSync(join(target, "tool"), "old");
		await expect(
			withPackageLock(target, (assertHeld) =>
				preparePackage(
					target,
					async () => {
						writeFileSync(join(target, "tool"), "external edit");
					},
					assertHeld,
				),
			),
		).rejects.toThrow("changed during preparation");
		expect(readFileSync(join(target, "tool"), "utf8")).toBe("external edit");
	});

	it("restores a missing active pathname before loading resources after interrupted promotion", async () => {
		await withPackageLock(target, (assertHeld) =>
			preparePackage(
				target,
				async (stage) => {
					mkdirSync(stage);
					writeFileSync(join(stage, "tool"), "old");
				},
				assertHeld,
			),
		);
		await withPackageLock(target, (assertHeld) =>
			preparePackage(
				target,
				async (stage) => {
					writeFileSync(join(stage, "tool"), "new");
				},
				assertHeld,
			),
		);
		const journal = join(dirname(target), `.${basename(target)}.pi-package-transaction.json`);
		const transaction = JSON.parse(readFileSync(journal, "utf8")) as { stage: string; phase: string };
		rmSync(target, { recursive: true });
		transaction.phase = "ready";
		writeFileSync(journal, JSON.stringify(transaction));
		const held = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const compiler = withPackageLock(join(root, transaction.stage), async () => {
			held.resolve();
			await released.promise;
		});
		try {
			await Promise.race([held.promise, compiler]);
			await withPackageLock(target, (assertHeld) => recoverPackage(target, assertHeld));
			expect(readFileSync(join(target, "tool"), "utf8")).toBe("old");
			expect(existsSync(journal)).toBe(true);
		} finally {
			released.resolve();
			await compiler;
		}
		await withPackageLock(target, (assertHeld) => recoverPackage(target, assertHeld));
		expect(existsSync(journal)).toBe(false);
	});

	it.each(["ready", "old-renamed", "candidate-renamed", "published"])(
		"recovers the %s publication checkpoint",
		async (checkpoint) => {
			mkdirSync(target);
			writeFileSync(join(target, "tool"), "old");
			await withPackageLock(target, (assertHeld) =>
				preparePackage(
					target,
					async (stage) => {
						writeFileSync(join(stage, "tool"), "new");
					},
					assertHeld,
				),
			);
			const journal = join(root, ".package.pi-package-transaction.json");
			const transaction = JSON.parse(readFileSync(journal, "utf8")) as {
				stage: string;
				backup: string;
				phase: string;
			};
			const stage = join(root, transaction.stage);
			const backup = join(root, transaction.backup);
			if (checkpoint === "ready" || checkpoint === "old-renamed") {
				renameSync(target, stage);
				if (checkpoint === "ready") renameSync(backup, target);
			}
			if (checkpoint !== "published") transaction.phase = "ready";
			writeFileSync(journal, JSON.stringify(transaction));
			await withPackageLock(target, (assertHeld) => recoverPackage(target, assertHeld));
			expect(readFileSync(join(target, "tool"), "utf8")).toBe(
				checkpoint === "ready" || checkpoint === "old-renamed" ? "old" : "new",
			);
			expect(existsSync(stage)).toBe(false);
			await withPackageLock(target, (assertHeld) =>
				preparePackage(
					target,
					async (candidate) => {
						writeFileSync(join(candidate, "tool"), "retry");
					},
					assertHeld,
				),
			);
			expect(readFileSync(join(target, "tool"), "utf8")).toBe("retry");
		},
	);

	it("retains a failed candidate and the working tool while its independent compiler lock is held", async () => {
		mkdirSync(target);
		writeFileSync(join(target, "tool"), "#!/bin/sh\nprintf old\n", { mode: 0o755 });
		const held = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		let writer = Promise.resolve();
		let candidate = "";
		try {
			await expect(
				withPackageLock(target, (assertHeld) =>
					preparePackage(
						target,
						async (stage) => {
							candidate = stage;
							writer = withPackageLock(stage, async () => {
								held.resolve();
								await released.promise;
							});
							await Promise.race([held.promise, writer]);
							throw new Error("outer adapter stopped");
						},
						assertHeld,
					),
				),
			).rejects.toThrow("outer adapter stopped");
			await withPackageLock(target, (assertHeld) => recoverPackage(target, assertHeld));
			expect(existsSync(candidate)).toBe(true);
			expect(execFileSync(join(target, "tool"), { encoding: "utf8" })).toBe("old");
			await expect(removePreparedPackage(target)).rejects.toThrow("needs recovery");
			expect(existsSync(candidate)).toBe(true);
			expect(execFileSync(join(target, "tool"), { encoding: "utf8" })).toBe("old");
		} finally {
			released.resolve();
			await writer;
		}
		await withPackageLock(target, (assertHeld) => recoverPackage(target, assertHeld));
		expect(existsSync(candidate)).toBe(false);
		expect(execFileSync(join(target, "tool"), { encoding: "utf8" })).toBe("old");
	});

	it("refuses promotion while an independent compiler still holds the candidate lock", async () => {
		mkdirSync(target);
		writeFileSync(join(target, "tool"), "old");
		const held = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		let writer = Promise.resolve();
		let candidate = "";
		try {
			await expect(
				withPackageLock(target, (assertHeld) =>
					preparePackage(
						target,
						async (stage) => {
							candidate = stage;
							writer = withPackageLock(stage, async () => {
								held.resolve();
								await released.promise;
							});
							await Promise.race([held.promise, writer]);
							writeFileSync(join(stage, "tool"), "new");
						},
						assertHeld,
					),
				),
			).rejects.toThrow("candidate compiler is still active");
			expect(readFileSync(join(target, "tool"), "utf8")).toBe("old");
			expect(existsSync(candidate)).toBe(true);
		} finally {
			released.resolve();
			await writer;
		}
		await withPackageLock(target, (assertHeld) => recoverPackage(target, assertHeld));
		expect(existsSync(candidate)).toBe(false);
	});

	it("does not execute compile arguments through an implicit shell", async () => {
		mkdirSync(target);
		writeFileSync(
			join(target, "package.json"),
			JSON.stringify({ pi: { compile: ["printf", "value; touch escaped"] } }),
		);
		const commands: Array<[string, string[]]> = [];
		await runPackageCompile(target, async (command, args) => {
			commands.push([command, args]);
		});
		expect(commands).toEqual([["printf", ["value; touch escaped"]]]);
		expect(existsSync(join(target, "escaped"))).toBe(false);
	});
});
