import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	packageLockPath,
	preparePackage,
	recoverPackage,
	removePreparedPackage,
	withPackageLock,
} from "../src/core/package-compile.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import * as gitSource from "../src/utils/git.ts";

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error("Fixture did not reach its lifecycle checkpoint");
		await new Promise((done) => setTimeout(done, 20));
	}
}

function git(root: string, ...args: string[]): string {
	return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

interface Transaction {
	stage: string;
	backup: string;
	phase: string;
	writerGroups: number[];
}

describe.skipIf(process.platform === "win32")("managed package compiler integration", () => {
	let root: string;
	let target: string;
	let origin: string;
	let adapter: string;
	let manager: DefaultPackageManager;
	let children: ChildProcess[];
	const source = "git:github.com/fixture/package";
	const compilerRoot = process.env.PI_COMPILED_ROOT;

	beforeEach(() => {
		expect(compilerRoot, "Set PI_COMPILED_ROOT to the reviewed pi-compiled checkout").toBeTruthy();
		root = mkdtempSync(join(tmpdir(), "pi-lifecycle-integration-"));
		target = join(root, "agent/git/github.com/fixture/package");
		origin = join(root, "origin");
		adapter = join(root, "compile.mjs");
		children = [];
		writeFileSync(
			adapter,
			`import { existsSync } from "node:fs";
import { ensureBuilt } from ${JSON.stringify(pathToFileURL(join(compilerRoot ?? "", "dist/index.js")).href)};
await ensureBuilt({ packageRoot: process.cwd(), binary: "bin/tool", buildCommand: [process.execPath, "build.mjs"], inputs: ["build.mjs"], cleanupPaths: ["scratch"], isUpstreamRequired: true, isGitVerificationRequired: true, overrideEnv: undefined, timeoutMs: existsSync(${JSON.stringify(join(root, "force-timeout"))}) ? 500 : 5000 });\n`,
		);
		mkdirSync(origin);
		git(origin, "init", "-b", "main");
		git(origin, "config", "user.email", "fixture@example.invalid");
		git(origin, "config", "user.name", "Fixture");
		writeFileSync(join(origin, ".gitignore"), "bin/\nscratch/\nnode_modules/\n");
		writeFileSync(
			join(origin, "package.json"),
			JSON.stringify({ pi: { compile: [process.execPath, adapter] }, dependencies: { fixture: "1.0.0" } }),
		);
		setBuild("old");
		git(origin, "add", ".");
		git(origin, "commit", "-m", "initial");
		const dependencyAdapter = join(root, "dependencies.mjs");
		writeFileSync(
			dependencyAdapter,
			`import { existsSync, mkdirSync, writeFileSync } from "node:fs";
if (existsSync(${JSON.stringify(join(root, "fail-dependencies"))})) process.exit(9);
mkdirSync("node_modules/fixture", {recursive:true}); writeFileSync("node_modules/fixture/value", "working");\n`,
		);
		manager = new DefaultPackageManager({
			cwd: root,
			agentDir: join(root, "agent"),
			settingsManager: SettingsManager.inMemory({
				packages: [source],
				npmCommand: [process.execPath, dependencyAdapter],
			}),
		});
		const parse = gitSource.parseGitUrl;
		vi.spyOn(gitSource, "parseGitUrl").mockImplementation((value) => {
			const parsed = parse(value);
			return parsed ? { ...parsed, repo: origin } : null;
		});
	});

	afterEach(async () => {
		writeFileSync(join(root, "release"), "release");
		for (const child of children) {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
		vi.restoreAllMocks();
		rmSync(root, { recursive: true, force: true });
	});

	function setBuild(value: string, isBlocked = false, isFailed = false): void {
		writeFileSync(
			join(origin, "build.mjs"),
			`import { existsSync, mkdirSync, writeFileSync } from "node:fs";
${isBlocked ? `writeFileSync(${JSON.stringify(join(root, "started"))}, String(process.pid)); while (!existsSync(${JSON.stringify(join(root, "release"))})) await new Promise(done => setTimeout(done, 20));` : ""}
mkdirSync("scratch", {recursive:true}); writeFileSync("scratch/generated", "generated");
${isFailed ? "process.exit(7);" : `mkdirSync("bin", {recursive:true}); writeFileSync("bin/tool", ${JSON.stringify(`#!/bin/sh\nprintf ${value}\n`)}, {mode:0o755});`}
writeFileSync(${JSON.stringify(join(root, "finished"))}, "finished");\n`,
		);
	}

	function advance(value: string, isBlocked = false, isFailed = false): void {
		setBuild(value, isBlocked, isFailed);
		git(origin, "add", "build.mjs");
		git(origin, "commit", "-m", value);
	}

	function transaction(): Transaction {
		return JSON.parse(
			readFileSync(join(root, "agent/git/github.com/fixture/.package.pi-package-transaction.json"), "utf8"),
		) as Transaction;
	}

	function start(script: string, args: string[] = []): ChildProcess {
		const path = join(root, `process-${children.length}.mjs`);
		writeFileSync(path, script);
		const child = spawn(process.execPath, [path, ...args], { cwd: root, stdio: "ignore" });
		children.push(child);
		return child;
	}

	function expectWorking(): void {
		expect(execFileSync(join(target, "bin/tool"), { encoding: "utf8" })).toBe("old");
		expect(readFileSync(join(target, "node_modules/fixture/value"), "utf8")).toBe("working");
		expect(readFileSync(join(target, "bin/tool.stamp"), "utf8")).toHaveLength(64);
	}

	it("keeps tracking branches buildable on update and repairs same-HEAD dependencies and cleanup", async () => {
		await manager.install(source);
		expectWorking();
		writeFileSync(join(target, "private-note"), "keep");
		advance("new");
		await manager.update(source);
		expect(git(target, "symbolic-ref", "--short", "HEAD")).toBe("main");
		expect(git(target, "rev-parse", "HEAD")).toBe(git(target, "rev-parse", "@{upstream}"));
		expect(execFileSync(join(target, "bin/tool"), { encoding: "utf8" })).toBe("new");
		expect(readFileSync(join(target, "private-note"), "utf8")).toBe("keep");
		rmSync(join(target, "node_modules"), { recursive: true });
		mkdirSync(join(target, "scratch"));
		writeFileSync(join(target, "scratch/retry"), "retry");
		await manager.update(source);
		expect(existsSync(join(target, "node_modules/fixture/value"))).toBe(true);
		expect(existsSync(join(target, "scratch"))).toBe(false);
	});

	it.each(["dependencies", "compile", "timeout"])(
		"preserves old tool, dependencies and stamp after %s failure and retries",
		async (failure) => {
			await manager.install(source);
			const stamp = readFileSync(join(target, "bin/tool.stamp"), "utf8");
			advance("broken", failure === "timeout", failure === "compile");
			if (failure === "dependencies") writeFileSync(join(root, "fail-dependencies"), "fail");
			if (failure === "timeout") writeFileSync(join(root, "force-timeout"), "fail");
			await expect(manager.install(source)).rejects.toThrow("Package preparation command failed");
			expectWorking();
			expect(readFileSync(join(target, "bin/tool.stamp"), "utf8")).toBe(stamp);
			rmSync(join(root, "fail-dependencies"), { force: true });
			rmSync(join(root, "force-timeout"), { force: true });
			advance("repaired");
			await manager.install(source);
			expect(execFileSync(join(target, "bin/tool"), { encoding: "utf8" })).toBe("repaired");
		},
	);

	it.each(["symlink", "gitfile", "config"])(
		"refuses %s indirection before mutating the outside sentinel",
		async (kind) => {
			await manager.install(source);
			const outside = join(root, "outside");
			mkdirSync(outside);
			writeFileSync(join(outside, "sentinel"), "untouched");
			if (kind === "symlink") {
				rmSync(join(target, "node_modules"), { recursive: true });
				symlinkSync(outside, join(target, "node_modules"));
			} else if (kind === "gitfile") {
				renameSync(join(target, ".git"), join(outside, "metadata"));
				writeFileSync(join(target, ".git"), `gitdir: ${join(outside, "metadata")}\n`);
			} else git(target, "config", "core.worktree", outside);
			await expect(manager.install(source)).rejects.toThrow(/indirection|real directories|indirect Git/);
			expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("untouched");
			expect(readdirSync(outside).sort()).toEqual(kind === "gitfile" ? ["metadata", "sentinel"] : ["sentinel"]);
		},
	);

	it("retains an ordinary preparation writer after owner death and retries interrupted first install", async () => {
		mkdirSync(join(target, ".."), { recursive: true });
		const helper = new URL("../src/core/package-compile.ts", import.meta.url).href;
		const writer = `import {existsSync,mkdirSync,writeFileSync} from "node:fs";
mkdirSync(process.argv[1]); writeFileSync(${JSON.stringify(join(root, "started"))}, "started");
while (!existsSync(${JSON.stringify(join(root, "release"))})) await new Promise(done => setTimeout(done,20));`;
		const owner = start(`import {withPackageLock,preparePackage} from ${JSON.stringify(helper)};
await withPackageLock(${JSON.stringify(target)}, held => preparePackage(${JSON.stringify(target)}, async(stage,existing,run) => {
await run(${JSON.stringify(process.execPath)}, ["--input-type=module", "-e", ${JSON.stringify(writer)}, stage]);
}, held));`);
		await waitUntil(() => existsSync(join(root, "started")));
		const stage = join(target, "..", transaction().stage);
		const exited = once(owner, "exit");
		owner.kill("SIGKILL");
		await exited;
		await withPackageLock(target, (held) => recoverPackage(target, held));
		expect(existsSync(stage)).toBe(true);
		expect(existsSync(target)).toBe(false);
		writeFileSync(join(root, "release"), "release");
		await waitUntil(async () => {
			await withPackageLock(target, (held) => recoverPackage(target, held));
			return !existsSync(stage);
		});
		await manager.install(source);
		expectWorking();
	}, 20_000);

	it("retains the actual detached compiler after owner and adapter death, then recovers safely", async () => {
		await manager.install(source);
		advance("new", true);
		const helper = pathToFileURL(fileURLToPath(new URL("../src/core/package-compile.ts", import.meta.url))).href;
		const owner = start(`import {withPackageLock, preparePackage} from ${JSON.stringify(helper)};
await withPackageLock(${JSON.stringify(target)}, held => preparePackage(${JSON.stringify(target)}, async (stage, existing, run) => {
await run("git", ["fetch", "origin"]); await run("git", ["reset", "--hard", "origin/main"]); await run(${JSON.stringify(process.execPath)}, [${JSON.stringify(adapter)}]);
}, held));`);
		await waitUntil(() => existsSync(join(root, "started")));
		const record = transaction();
		const stage = join(target, "..", record.stage);
		const ownerExited = once(owner, "exit");
		owner.kill("SIGKILL");
		await ownerExited;
		const group = record.writerGroups[0];
		if (group === undefined || group <= 1) throw new Error("Missing outer adapter process group");
		process.kill(-group, "SIGKILL");
		await waitUntil(() => {
			try {
				process.kill(-group, 0);
				return false;
			} catch {
				return true;
			}
		});
		await withPackageLock(target, (held) => recoverPackage(target, held));
		expect(existsSync(stage)).toBe(true);
		expectWorking();
		await expect(removePreparedPackage(target)).rejects.toThrow("needs recovery");
		writeFileSync(join(root, "release"), "release");
		await waitUntil(async () => {
			await withPackageLock(target, (held) => recoverPackage(target, held));
			return !existsSync(stage);
		});
		expectWorking();
	}, 20_000);

	it("rejects a delayed actual compiler worker without recreating a discarded candidate", async () => {
		await manager.install(source);
		let candidate = "";
		let child: ChildProcess | undefined;
		await expect(
			withPackageLock(target, (held) =>
				preparePackage(
					target,
					async (stage) => {
						candidate = stage;
						const spec = {
							packageRoot: stage,
							binary: "bin/tool",
							buildCommand: [process.execPath, "build.mjs"],
							inputs: ["build.mjs"],
							cleanupPaths: [],
							isGitVerificationRequired: true,
							isUpstreamRequired: true,
						};
						const worker = join(compilerRoot ?? "", "dist/worker.js");
						const tool =
							process.platform === "darwin"
								? "/usr/bin/lockf"
								: ["/usr/bin/flock", "/bin/flock"].find(existsSync);
						expect(tool).toBeTruthy();
						const args = process.platform === "darwin" ? ["-k", "-s", "-t", "5"] : ["-w", "5", "-E", "75"];
						child = spawn(
							"/bin/sh",
							[
								"-c",
								'printf ready; read -r admission; exec "$@"',
								"fixture",
								tool ?? "",
								...args,
								packageLockPath(stage),
								process.execPath,
								worker,
								JSON.stringify(spec),
								"package",
							],
							{ cwd: root, stdio: ["pipe", "pipe", "ignore"] },
						);
						children.push(child);
						if (!child.stdout) throw new Error("Missing compiler admission pipe");
						await once(child.stdout, "data");
						throw new Error("discard");
					},
					held,
				),
			),
		).rejects.toThrow("discard");
		if (!child) throw new Error("Delayed compiler was not started");
		const exited = once(child, "exit");
		child.stdin?.end("admit\n");
		const [status] = await exited;
		expect(status).not.toBe(0);
		expect(existsSync(candidate)).toBe(false);
		expectWorking();
	});

	it("serializes remove behind preparation and adopted active compilation", async () => {
		await manager.install(source);
		const held = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const updating = withPackageLock(target, (assertHeld) =>
			preparePackage(
				target,
				async () => {
					held.resolve();
					await release.promise;
				},
				assertHeld,
			),
		);
		await held.promise;
		let isRemoved = false;
		const removing = removePreparedPackage(target).then(() => {
			isRemoved = true;
		});
		await new Promise((done) => setTimeout(done, 40));
		expect(isRemoved).toBe(false);
		release.resolve();
		await updating;
		await removing;
		expect(existsSync(target)).toBe(false);
		await manager.install(source);
		advance("active", true);
		git(target, "fetch", "origin");
		git(target, "reset", "--hard", "origin/main");
		const compiler = spawn(process.execPath, [adapter], { cwd: target, stdio: "ignore" });
		children.push(compiler);
		const compilerExited = once(compiler, "exit");
		await waitUntil(() => existsSync(join(root, "started")));
		isRemoved = false;
		const removeActive = removePreparedPackage(target).then(() => {
			isRemoved = true;
		});
		await new Promise((done) => setTimeout(done, 40));
		expect(isRemoved).toBe(false);
		writeFileSync(join(root, "release"), "release");
		const [status] = await compilerExited;
		expect(status).toBe(0);
		await removeActive;
		expect(existsSync(target)).toBe(false);
	}, 20_000);
});
