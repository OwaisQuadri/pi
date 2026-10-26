import { createHash, randomUUID } from "node:crypto";
import {
	constants,
	cpSync,
	createReadStream,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnProcess } from "../utils/child-process.ts";
import { isStdoutTakenOver } from "./output-guard.ts";

interface PackageTransaction {
	version: 1;
	stage: string;
	backup: string;
	phase: "preparing" | "ready" | "published";
	oldDigest: string | null;
	newDigest: string | null;
	writerGroups: number[];
}

export type PackageCommand = (command: string, args: string[]) => Promise<void>;

export function readCompileCommand(packageRoot: string): string[] | undefined {
	const path = join(packageRoot, "package.json");
	if (!existsSync(path)) return undefined;
	const pkg: unknown = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
	if (typeof pkg !== "object" || pkg === null || !("pi" in pkg)) return undefined;
	const pi = pkg.pi;
	if (typeof pi !== "object" || pi === null || !("compile" in pi)) return undefined;
	const command = pi.compile;
	if (
		!Array.isArray(command) ||
		command.length === 0 ||
		!command.every((part: unknown) => typeof part === "string" && part.length > 0 && !part.includes("\0"))
	) {
		throw new Error("pi.compile must be a nonempty command argument array");
	}
	return command;
}

export function packageLockPath(target: string): string {
	return join(realpathSync(dirname(target)), `.${basename(target)}.pi-package.lock`);
}

function journalPath(target: string): string {
	return join(dirname(target), `.${basename(target)}.pi-package-transaction.json`);
}

export function isPackageRecoveryNeeded(target: string): boolean {
	return existsSync(journalPath(target));
}

class PackageLockBusy extends Error {}

export async function withPackageLock<T>(
	target: string,
	operation: (assertHeld: () => void) => Promise<T>,
	isNonBlocking = false,
): Promise<T> {
	mkdirSync(dirname(target), { recursive: true });
	const tool = process.platform === "darwin" ? "/usr/bin/lockf" : ["/usr/bin/flock", "/bin/flock"].find(existsSync);
	if (!tool || !existsSync(tool)) throw new Error("Package updates require lockf or flock");
	const args =
		process.platform === "darwin"
			? isNonBlocking
				? ["-k", "-s", "-t", "0"]
				: ["-k", "-s", "-t", "60"]
			: isNonBlocking
				? ["-n", "-E", "75"]
				: ["-w", "60", "-E", "75"];
	const child = spawnProcess(
		tool,
		[...args, packageLockPath(target), "/bin/sh", "-c", 'printf "locked\\n"; read -r release'],
		{
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	let isHeld = false;
	let isReleased = false;
	const exit = new Promise<void>((done, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => {
			const isAcquired = isHeld;
			isHeld = false;
			if (!isReleased && isNonBlocking && !isAcquired && code === 75)
				reject(new PackageLockBusy("The candidate package lock is busy"));
			else if (!isReleased) reject(new Error("The package mutation lock was lost"));
			else done();
		});
	});
	exit.catch(() => undefined);
	child.stdin?.on("error", () => undefined);
	try {
		await Promise.race([
			new Promise<void>((done) => {
				child.stdout?.once("data", () => {
					isHeld = true;
					done();
				});
			}),
			exit,
		]);
		if (!isHeld) throw new Error("The package mutation lock was not acquired");
		return await operation(() => {
			if (!isHeld || !child.pid) throw new Error("The package mutation lock was lost");
			process.kill(child.pid, 0);
		});
	} finally {
		isReleased = true;
		child.stdin?.end("release\n");
		await exit;
		child.stdout?.destroy();
		child.stderr?.destroy();
	}
}

async function withCandidateLock<T>(
	target: string,
	transaction: PackageTransaction,
	operation: (assertHeld: () => void) => Promise<T>,
): Promise<T | undefined> {
	try {
		const stage = join(dirname(target), transaction.stage);
		return await withPackageLock(
			stage,
			async (assertHeld) => {
				if (JSON.stringify(readJournal(target)) !== JSON.stringify(transaction))
					throw new Error("The package transaction changed; retained all files");
				if (existsSync(stage)) assertDirectory(stage);
				return operation(assertHeld);
			},
			true,
		);
	} catch (error) {
		if (!(error instanceof PackageLockBusy)) throw error;
		return undefined;
	}
}

async function treeDigest(root: string): Promise<string> {
	const hash = createHash("sha256");
	async function visit(path: string, name: string): Promise<void> {
		const stat = lstatSync(path);
		hash.update(
			JSON.stringify([name, stat.mode, stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : "file"]),
		);
		if (stat.isSymbolicLink()) hash.update(readlinkSync(path));
		else if (stat.isDirectory()) {
			for (const entry of readdirSync(path).sort()) await visit(join(path, entry), `${name}/${entry}`);
		} else if (stat.isFile()) {
			for await (const chunk of createReadStream(path)) hash.update(chunk);
		} else throw new Error("A package contains an unsupported filesystem entry; no files were removed");
	}
	await visit(root, "");
	return hash.digest("hex");
}

function writeJournal(target: string, transaction: PackageTransaction): void {
	const path = journalPath(target);
	const temporary = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temporary, JSON.stringify(transaction), { flag: "wx", mode: 0o600 });
	renameSync(temporary, path);
}

function readJournal(target: string): PackageTransaction {
	const value: unknown = JSON.parse(readFileSync(journalPath(target), "utf8"));
	if (typeof value !== "object" || value === null) throw new Error("Invalid package recovery journal");
	const record = value as Record<string, unknown>;
	const prefix = `.${basename(target)}.pi-`;
	const isName = (name: unknown, kind: string): name is string =>
		typeof name === "string" &&
		name.startsWith(`${prefix}${kind}-`) &&
		/^[a-f0-9-]{36}$/.test(name.slice(`${prefix}${kind}-`.length));
	const isDigest = (digest: unknown): digest is string | null =>
		digest === null || (typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest));
	if (
		record.version !== 1 ||
		!isName(record.stage, "stage") ||
		!isName(record.backup, "backup") ||
		!["preparing", "ready", "published"].includes(String(record.phase)) ||
		!isDigest(record.oldDigest) ||
		!isDigest(record.newDigest) ||
		!Array.isArray(record.writerGroups) ||
		!record.writerGroups.every(
			(group: unknown) => typeof group === "number" && Number.isSafeInteger(group) && group > 1,
		)
	)
		throw new Error("Invalid package recovery journal; retained all files");
	return record as unknown as PackageTransaction;
}

export function assertPackageIsolation(root: string): void {
	const visit = (path: string): void => {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) {
			const destination = resolve(dirname(path), readlinkSync(path));
			const local = relative(root, destination);
			if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) {
				throw new Error("Managed package preparation refuses external symlink indirection");
			}
		} else if (stat.isDirectory()) {
			for (const entry of readdirSync(path)) visit(join(path, entry));
		} else if (!stat.isFile()) {
			throw new Error("Managed package preparation requires regular files and directories");
		}
	};
	assertDirectory(root);
	visit(root);
	assertDirectory(join(root, ".git"));
	for (const name of ["commondir", "gitdir", "objects/info/alternates", "objects/info/http-alternates"]) {
		if (existsSync(join(root, ".git", name)))
			throw new Error("Managed package preparation refuses indirect Git metadata");
	}
}

function assertDirectory(path: string): void {
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new Error("Package transaction paths must be real directories");
}

export async function recoverPackage(target: string, assertHeld: () => void = () => undefined): Promise<void> {
	if (!isPackageRecoveryNeeded(target)) return;
	const transaction = readJournal(target);
	const stage = join(dirname(target), transaction.stage);
	const backup = join(dirname(target), transaction.backup);
	if (existsSync(target)) assertDirectory(target);
	if (existsSync(backup)) assertDirectory(backup);
	if (existsSync(stage)) assertDirectory(stage);
	if (!existsSync(target) && existsSync(backup)) {
		if ((await treeDigest(backup)) !== transaction.oldDigest)
			throw new Error("Package recovery backup changed; retained all files");
		assertHeld();
		renameSync(backup, target);
	}
	if (transaction.phase === "published") return;
	if (!existsSync(target) && transaction.oldDigest !== null) {
		throw new Error("The previous package is missing; retained all recovery files");
	}
	if (transaction.writerGroups.some(isProcessGroupAlive)) return;
	await withCandidateLock(target, transaction, async (assertCandidateHeld) => {
		const digest = existsSync(target) ? await treeDigest(target) : null;
		assertHeld();
		assertCandidateHeld();
		if (digest === transaction.oldDigest) {
			rmSync(stage, { recursive: true, force: true });
			rmSync(journalPath(target));
			return;
		}
		if (digest !== transaction.newDigest)
			throw new Error("Package recovery found an unverified active generation; retained all files");
		if (existsSync(stage)) throw new Error("Package recovery found an ambiguous stage; retained all files");
		transaction.phase = "published";
		writeJournal(target, transaction);
	});
}

async function retireTransaction(target: string, assertHeld: () => void): Promise<void> {
	if (isPackageRecoveryNeeded(target)) {
		const previous = readJournal(target);
		if (previous.phase !== "published") {
			throw new Error(
				"The previous package is usable, but an interrupted candidate needs recovery before another update",
			);
		}
		const isRetired = await withCandidateLock(target, previous, async (assertCandidateHeld) => {
			if (existsSync(join(dirname(target), previous.stage)))
				throw new Error("A published package still has a candidate; retained all files");
			const backup = join(dirname(target), previous.backup);
			if (existsSync(backup)) {
				if ((await treeDigest(backup)) !== previous.oldDigest)
					throw new Error("The retained package changed; no files were removed");
				assertHeld();
				assertCandidateHeld();
				rmSync(backup, { recursive: true });
			}
			assertHeld();
			assertCandidateHeld();
			rmSync(journalPath(target));
			return true;
		});
		if (!isRetired) throw new Error("The previous candidate compiler is still active; retained all files");
	}
}

export async function removePreparedPackage(target: string): Promise<void> {
	await withPackageLock(target, async (assertHeld) => {
		await recoverPackage(target, assertHeld);
		await retireTransaction(target, assertHeld);
		if (existsSync(target)) assertDirectory(target);
		assertHeld();
		rmSync(target, { recursive: true, force: true });
	});
}

export async function preparePackage(
	target: string,
	prepare: (stage: string, isExisting: boolean, run: PackageCommand) => Promise<void>,
	assertHeld: () => void = () => undefined,
): Promise<void> {
	await recoverPackage(target, assertHeld);
	if (existsSync(target)) assertDirectory(target);
	await retireTransaction(target, assertHeld);
	const id = randomUUID();
	const transaction: PackageTransaction = {
		version: 1,
		stage: `.${basename(target)}.pi-stage-${id}`,
		backup: `.${basename(target)}.pi-backup-${id}`,
		phase: "preparing",
		oldDigest: existsSync(target) ? await treeDigest(target) : null,
		newDigest: null,
		writerGroups: [],
	};
	const stage = join(dirname(target), transaction.stage);
	const backup = join(dirname(target), transaction.backup);
	assertHeld();
	writeJournal(target, transaction);
	let isReady = false;
	try {
		if (transaction.oldDigest !== null)
			cpSync(target, stage, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
		await prepare(stage, transaction.oldDigest !== null, async (command, args) => {
			assertHeld();
			await runPreparedCommand(target, stage, transaction, command, args, assertHeld);
		});
		assertHeld();
		if (transaction.writerGroups.some(isProcessGroupAlive))
			throw new Error("Package preparation still has live writers");
		const isPublished = await withCandidateLock(target, transaction, async (assertCandidateHeld) => {
			const newDigest = await treeDigest(stage);
			if (transaction.oldDigest !== null && (await treeDigest(target)) !== transaction.oldDigest) {
				throw new Error("The active package changed during preparation; no active files were replaced");
			}
			assertHeld();
			assertCandidateHeld();
			transaction.newDigest = newDigest;
			transaction.phase = "ready";
			writeJournal(target, transaction);
			isReady = true;
			if (transaction.oldDigest !== null) renameSync(target, backup);
			try {
				renameSync(stage, target);
			} catch (error) {
				if (!existsSync(target) && existsSync(backup)) renameSync(backup, target);
				throw error;
			}
			transaction.phase = "published";
			writeJournal(target, transaction);
			return true;
		});
		if (!isPublished) throw new Error("The candidate compiler is still active; retained the candidate for recovery");
	} catch (error) {
		if (!isReady && !transaction.writerGroups.some(isProcessGroupAlive)) {
			await withCandidateLock(target, transaction, async (assertCandidateHeld) => {
				assertHeld();
				assertCandidateHeld();
				rmSync(stage, { recursive: true, force: true });
				rmSync(journalPath(target), { force: true });
			});
		}
		throw error;
	}
}

function isProcessGroupAlive(group: number): boolean {
	try {
		process.kill(-group, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

async function runPreparedCommand(
	target: string,
	stage: string,
	transaction: PackageTransaction,
	command: string,
	args: string[],
	assertHeld: () => void,
): Promise<void> {
	await new Promise<void>((done, reject) => {
		const child = spawnProcess(
			"/bin/sh",
			[
				"-c",
				'IFS= read -r admission || exit 75; [ "$admission" = "$1" ] || exit 75; shift; exec "$@"',
				"pi-package",
				transaction.stage,
				command,
				...args,
			],
			{
				cwd: existsSync(stage) ? stage : dirname(stage),
				detached: true,
				stdio: ["pipe", isStdoutTakenOver() ? 2 : "inherit", "inherit"],
			},
		);
		let failure: Error | undefined;
		const stop = () => {
			if (child.pid) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {}
			}
		};
		const timer = setTimeout(() => {
			failure = new Error("Package preparation command exceeded 600 seconds");
			stop();
		}, 600_000);
		child.stdin?.on("error", () => undefined);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", async (code) => {
			clearTimeout(timer);
			stop();
			if (!failure && code !== 0)
				failure = new Error(
					`Package preparation command failed with ${code === null ? "a signal" : `code ${code}`}`,
				);
			const deadline = Date.now() + 5_000;
			while (child.pid && isProcessGroupAlive(child.pid) && Date.now() < deadline) {
				await new Promise<void>((resolve) => setTimeout(resolve, 20));
			}
			if (child.pid && isProcessGroupAlive(child.pid)) {
				reject(new Error("Package writers have not stopped; retained the candidate for recovery"));
				return;
			}
			if (failure) reject(failure);
			else done();
		});
		if (!child.pid) {
			child.stdin?.end();
			return;
		}
		transaction.writerGroups.push(child.pid);
		try {
			assertHeld();
			writeJournal(target, transaction);
			child.stdin?.end(`${transaction.stage}\n`);
		} catch (error) {
			failure = error instanceof Error ? error : new Error(String(error));
			child.stdin?.end();
			stop();
		}
	});
	assertHeld();
	transaction.writerGroups = [];
	writeJournal(target, transaction);
}

export async function runPackageCompile(root: string, run: PackageCommand): Promise<void> {
	const command = readCompileCommand(root);
	if (command) await run(command[0], command.slice(1));
}
