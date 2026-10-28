import type { TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { AgentSessionRuntime, type AgentSessionServices } from "../src/core/agent-session-runtime.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import {
	bindNativeMemoryConversationContext,
	bindNativeMemoryConversationRunner,
	bindNativeMemoryConversationView,
	getMemoryConversation,
	type MemoryConversation,
	MemoryConversationController,
	type MemoryConversationProposal,
	revokeNativeMemoryConversationRunner,
	unbindNativeMemoryConversationView,
} from "../src/core/memory-conversation.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { createHarness } from "./suite/harness.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
	vi.unstubAllEnvs();
});

async function createFixture() {
	vi.stubEnv("PI_OFFLINE", "1");
	let facade: MemoryConversation | undefined;
	let ui: ExtensionUIContext | undefined;
	let presented: MemoryConversationProposal | undefined;
	const harness = await createHarness({
		settings: { tuiMode: "regular" },
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "native_memory_view_case",
					label: "Native memory view case",
					description: "Exercise the owned native transcript view",
					parameters: Type.Object({ id: Type.String(), text: Type.String() }),
					execute: async (_id, args, _signal, _onUpdate, ctx) => {
						facade = getMemoryConversation(ctx);
						ui = ctx.ui;
						presented = facade?.present(args);
						return { content: [{ type: "text", text: presented ? "presented" : "blocked" }], details: {} };
					},
				});
			},
		],
	});
	const services: AgentSessionServices = {
		cwd: harness.tempDir,
		agentDir: harness.tempDir,
		modelRuntime: harness.session.modelRuntime,
		settingsManager: harness.settingsManager,
		resourceLoader: harness.session.resourceLoader,
		diagnostics: [],
	};
	const runtime = new AgentSessionRuntime(harness.session, services, async () => {
		throw new Error("This fixture does not replace sessions");
	});
	const terminal = new VirtualTerminal(100, 30);
	const mode = new InteractiveMode(runtime, { terminal });
	let isStopped = false;
	const stop = () => {
		if (isStopped) return;
		isStopped = true;
		mode.stop();
	};
	cleanups.push(() => {
		try {
			stop();
		} finally {
			harness.cleanup();
		}
	});
	const tool = harness.session.agent.state.tools.find((candidate) => candidate.name === "native_memory_view_case");
	if (!tool) throw new Error("The native tool wrapper is missing");
	return {
		harness,
		mode,
		terminal,
		stop,
		get facade() {
			if (!facade) throw new Error("The tool context has no native facade");
			return facade;
		},
		get ui() {
			if (!ui) throw new Error("The tool context has no native UI context");
			return ui;
		},
		async present(text: string, id = "proposal-1") {
			presented = undefined;
			await tool.execute("native-view-case", { id, text }, undefined, undefined);
			return presented;
		},
	};
}

describe("owned native memory transcript view", () => {
	it("requires an initialized native host and preserves literal proposal text", async () => {
		const fixture = await createFixture();
		const text = "Keep literal **asterisks** and `ticks`.";
		expect(await fixture.present(text)).toBeUndefined();
		await fixture.mode.init();
		const proposal = await fixture.present(text);
		expect(proposal).toEqual({ id: "proposal-1", text });
		expect(Object.isFrozen(proposal)).toBe(true);
		await fixture.terminal.flush();
		expect(fixture.terminal.getScrollBuffer().join("\n")).toContain(text);
	});

	it("rejects blank text and terminal control sequences", async () => {
		const fixture = await createFixture();
		await fixture.mode.init();
		for (const text of [" \t\n", "hidden\x1b[2J", "hidden\rreplacement", "hidden\x9b2J"]) {
			expect(await fixture.present(text)).toBeUndefined();
		}
		expect(await fixture.present("First line\nSecond\tline")).toEqual({
			id: "proposal-1",
			text: "First line\nSecond\tline",
		});
	});

	it("rebuilds after a same-runner context reset without reviving an earlier facade", async () => {
		const fixture = await createFixture();
		await fixture.mode.init();
		expect(await fixture.present("First proposal")).toBeDefined();
		const beforeReset = fixture.facade;
		fixture.harness.session.refreshContext();
		expect(beforeReset.present({ id: "stale", text: "Stale proposal" })).toBeUndefined();
		expect(await fixture.present("Current proposal", "proposal-2")).toBeDefined();
		expect(beforeReset.present({ id: "stale", text: "Still stale" })).toBeUndefined();
	});

	it("revokes before an editor factory and requires the default editor", async () => {
		const fixture = await createFixture();
		await fixture.mode.init();
		await fixture.present("First proposal");
		const beforeFactory = fixture.facade;
		let isFactoryCalled = false;
		let duringFactory: MemoryConversationProposal | undefined;
		fixture.ui.setEditorComponent((ui, theme, keybindings) => {
			isFactoryCalled = true;
			duringFactory = beforeFactory.present({ id: "stale", text: "During replacement" });
			return new CustomEditor(ui, theme, keybindings);
		});
		expect(isFactoryCalled).toBe(true);
		expect(duringFactory).toBeUndefined();
		expect(await fixture.present("Not the default editor")).toBeUndefined();
		fixture.ui.setEditorComponent(undefined);
		expect(await fixture.present("Default editor restored", "proposal-2")).toBeDefined();
		expect(beforeFactory.present({ id: "stale", text: "Still stale" })).toBeUndefined();
	});

	it("does not revive a facade when the same renderer stops and resumes", async () => {
		const fixture = await createFixture();
		await fixture.mode.init();
		await fixture.present("Capture the built-in renderer");
		let renderer: TUI | undefined;
		fixture.ui.setEditorComponent((ui, theme, keybindings) => {
			renderer = ui;
			return new CustomEditor(ui, theme, keybindings);
		});
		fixture.ui.setEditorComponent(undefined);
		await fixture.present("Before the pause", "proposal-2");
		const beforePause = fixture.facade;
		if (!renderer) throw new Error("The native renderer was not captured");
		renderer.stop();
		expect(beforePause.present({ id: "paused", text: "While stopped" })).toBeUndefined();
		renderer.start();
		expect(beforePause.present({ id: "stale", text: "After restart" })).toBeUndefined();
		expect(await fixture.present("Fresh view after restart", "proposal-3")).toBeDefined();
	});

	it("does not rebuild a retired interactive host", async () => {
		const fixture = await createFixture();
		await fixture.mode.init();
		await fixture.present("Before retirement");
		const beforeStop = fixture.facade;
		fixture.stop();
		expect(beforeStop.present({ id: "stale", text: "Retired view" })).toBeUndefined();
		expect(await fixture.present("No interactive owner")).toBeUndefined();
	});
});

describe("native view registry lifetime", () => {
	it("rebuilds before minting a context and clears the callback on unbind", () => {
		const runner = {};
		const owner = {};
		const controller = new MemoryConversationController();
		const view = { isActive: () => true, present: () => () => true };
		let rebindCount = 0;
		const bind = () => {
			bindNativeMemoryConversationView(runner, view, () => {
				rebindCount++;
				bind();
			});
		};
		bindNativeMemoryConversationRunner(runner, controller);
		bind();
		controller.invalidate();
		const current = {};
		bindNativeMemoryConversationContext(current, runner, owner);
		expect(rebindCount).toBe(1);
		expect(getMemoryConversation(current)?.present({ id: "current", text: "Current" })).toBeDefined();
		unbindNativeMemoryConversationView(runner);
		const afterUnbind = {};
		bindNativeMemoryConversationContext(afterUnbind, runner, owner);
		expect(rebindCount).toBe(1);
		expect(getMemoryConversation(afterUnbind)?.present({ id: "closed", text: "Closed" })).toBeUndefined();
		revokeNativeMemoryConversationRunner(runner);
	});

	it("does not mint a facade when rebuilding retires the actual runner", () => {
		const runner = {};
		const controller = new MemoryConversationController();
		bindNativeMemoryConversationRunner(runner, controller);
		bindNativeMemoryConversationView(runner, { isActive: () => true, present: () => () => true }, () =>
			revokeNativeMemoryConversationRunner(runner),
		);
		controller.invalidate();
		const context = {};
		bindNativeMemoryConversationContext(context, runner, {});
		expect(getMemoryConversation(context)).toBeUndefined();
	});
});
