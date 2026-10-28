import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { AgentSessionRuntime, type AgentSessionServices } from "../src/core/agent-session-runtime.ts";
import { getMemoryConversation, type MemoryConversationReply } from "../src/core/memory-conversation.ts";
import type { InlineExtension } from "../src/index.ts";
import type { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { createHarness, getUserTexts } from "./suite/harness.ts";

const cleanups: Array<() => void> = [];
type FlushOptions = Partial<Pick<Extract<AgentSessionEvent, { type: "compaction_end" }>, "willRetry">>;

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

async function createFixture(extraExtension?: InlineExtension) {
	vi.stubEnv("PI_OFFLINE", "1");
	const replies: Array<MemoryConversationReply | undefined> = [];
	let loopError: unknown;
	const harness = await createHarness({
		settings: { tuiMode: "regular" },
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "native_memory_input_case",
					label: "Native input case",
					description: "Inspect a synthetic native reply without memory effects",
					parameters: Type.Object({ kind: Type.Union([Type.Literal("present"), Type.Literal("resolve")]) }),
					execute: async (_id, args, _signal, _onUpdate, context) => {
						const facade = getMemoryConversation(context);
						if (args.kind === "present") {
							const proposal = facade?.present({
								id: "proposal-1",
								text: "A synthetic proposal with no memory effect.",
							});
							return { content: [{ type: "text", text: proposal ? "presented" : "blocked" }], details: {} };
						}
						replies.push(facade?.resolveReply("proposal-1"));
						return { content: [{ type: "text", text: "Reply inspected" }], details: {} };
					},
				});
			},
			...(extraExtension ? [extraExtension] : []),
		],
	});
	vi.stubEnv(ENV_AGENT_DIR, harness.tempDir);
	const services: AgentSessionServices = {
		cwd: harness.tempDir,
		agentDir: harness.tempDir,
		modelRuntime: harness.session.modelRuntime,
		settingsManager: harness.settingsManager,
		resourceLoader: harness.session.resourceLoader,
		diagnostics: [],
	};
	const runtime = new AgentSessionRuntime(harness.session, services, async () => {
		throw new Error("The native input fixture does not replace sessions");
	});
	const terminal = new VirtualTerminal(100, 30);
	const mode = new InteractiveMode(runtime, { terminal });
	const host = mode as unknown as {
		defaultEditor: CustomEditor;
		getAllQueuedMessages(): { steering: string[]; followUp: string[] };
		flushCompactionQueue(options?: FlushOptions): Promise<void>;
		showError(text: string): void;
	};
	cleanups.push(() => {
		try {
			mode.stop();
		} finally {
			harness.cleanup();
		}
	});
	await mode.init();
	const tool = harness.session.agent.state.tools.find((candidate) => candidate.name === "native_memory_input_case");
	if (!tool) throw new Error("The native input fixture tool is missing");
	const responses = () => [
		fauxAssistantMessage(fauxToolCall("native_memory_input_case", { kind: "resolve" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Done"),
	];
	return {
		harness,
		mode,
		host,
		terminal,
		replies,
		responses,
		startLoop() {
			void mode.run().catch((error: unknown) => {
				loopError = error;
			});
		},
		async present() {
			const result = await tool.execute("present-input-case", { kind: "present" }, undefined, undefined);
			expect(result.content).toEqual([{ type: "text", text: "presented" }]);
		},
		async completeReply() {
			await vi.waitFor(() => {
				expect(loopError).toBeUndefined();
				expect(replies).toHaveLength(1);
				expect(harness.session.isStreaming).toBe(false);
			});
		},
	};
}

describe("native memory input transport", () => {
	it("routes actual terminal Enter through the private normal input queue", async () => {
		const fixture = await createFixture();
		fixture.harness.setResponses(fixture.responses());
		await fixture.present();
		fixture.host.defaultEditor.setText("  Yes, remember that.  ");
		fixture.terminal.sendInput("\r");
		fixture.startLoop();
		await fixture.completeReply();
		expect(fixture.replies[0]).toEqual({
			proposalId: "proposal-1",
			originalText: "  Yes, remember that.  ",
			submittedText: "Yes, remember that.",
		});
	});

	it("keeps the original reply when input handlers transform model text", async () => {
		const fixture = await createFixture((pi) => {
			pi.on("input", () => ({ action: "transform", text: "Transformed model input" }));
		});
		fixture.harness.setResponses(fixture.responses());
		await fixture.present();
		fixture.host.defaultEditor.setText(" Yes ");
		fixture.terminal.sendInput("\r");
		fixture.startLoop();
		await fixture.completeReply();
		expect(getUserTexts(fixture.harness)).toContain("Transformed model input");
		expect(fixture.replies[0]?.originalText).toBe(" Yes ");
		expect(fixture.replies[0]?.submittedText).toBe("Yes");
	});

	it("accepts a synchronous exact forwarding callback", async () => {
		const fixture = await createFixture();
		fixture.harness.setResponses(fixture.responses());
		await fixture.present();
		const submit = fixture.host.defaultEditor.onSubmit;
		fixture.host.defaultEditor.onSubmit = (text) => submit?.(text);
		fixture.host.defaultEditor.setText("Yes");
		fixture.terminal.sendInput("\r");
		fixture.startLoop();
		await fixture.completeReply();
		expect(fixture.replies[0]?.originalText).toBe("Yes");
	});

	it("drops origin when a callback forwards different text", async () => {
		const fixture = await createFixture();
		fixture.harness.setResponses(fixture.responses());
		await fixture.present();
		const submit = fixture.host.defaultEditor.onSubmit;
		fixture.host.defaultEditor.onSubmit = () => submit?.("Changed text");
		fixture.host.defaultEditor.setText("Yes");
		fixture.terminal.sendInput("\r");
		fixture.startLoop();
		await fixture.completeReply();
		expect(fixture.replies).toEqual([undefined]);
	});

	it("does not retain origin for an asynchronous forwarding callback", async () => {
		const fixture = await createFixture();
		fixture.harness.setResponses(fixture.responses());
		await fixture.present();
		const submit = fixture.host.defaultEditor.onSubmit;
		fixture.host.defaultEditor.onSubmit = (text) => {
			queueMicrotask(() => submit?.(text));
		};
		fixture.host.defaultEditor.setText("Yes");
		fixture.terminal.sendInput("\r");
		fixture.startLoop();
		await fixture.completeReply();
		expect(fixture.replies).toEqual([undefined]);
	});

	it.each(["suppressed", "throwing"])("clears a %s submit scope before a later public callback", async (kind) => {
		const fixture = await createFixture();
		fixture.harness.setResponses(fixture.responses());
		await fixture.present();
		const submit = fixture.host.defaultEditor.onSubmit;
		fixture.host.defaultEditor.onSubmit = () => {
			if (kind === "throwing") throw new Error("Synthetic submit failure");
		};
		fixture.host.defaultEditor.setText("Yes");
		if (kind === "throwing") expect(() => fixture.terminal.sendInput("\r")).toThrow("Synthetic submit failure");
		else fixture.terminal.sendInput("\r");
		fixture.host.defaultEditor.onSubmit = submit;
		await submit?.("Yes");
		fixture.startLoop();
		await fixture.completeReply();
		expect(fixture.replies).toEqual([undefined]);
	});

	it("does not transfer a nested programmatic submit from onChange", async () => {
		const fixture = await createFixture();
		fixture.harness.setResponses(fixture.responses());
		await fixture.present();
		let isReentered = false;
		fixture.host.defaultEditor.setText("Yes");
		fixture.host.defaultEditor.onChange = () => {
			if (isReentered) return;
			isReentered = true;
			fixture.host.defaultEditor.setText("Nested input");
			fixture.host.defaultEditor.handleInput("\r");
		};
		fixture.terminal.sendInput("\r");
		expect(await fixture.mode.getUserInput()).toBe("Nested input");
		fixture.host.defaultEditor.onChange = undefined;
		fixture.startLoop();
		await fixture.completeReply();
		expect(fixture.replies).toEqual([undefined]);
	});

	it("does not trust a programmatic editor submit", async () => {
		const fixture = await createFixture();
		fixture.harness.setResponses(fixture.responses());
		await fixture.present();
		fixture.host.defaultEditor.setText("Yes");
		fixture.host.defaultEditor.handleInput("\r");
		fixture.startLoop();
		await fixture.completeReply();
		expect(fixture.replies).toEqual([undefined]);
	});

	it("does not turn a serialized interactive SDK flag into native input", async () => {
		const fixture = await createFixture();
		fixture.harness.setResponses(fixture.responses());
		await fixture.present();
		await fixture.harness.session.prompt("Yes", { source: "interactive" });
		expect(fixture.replies).toEqual([undefined]);
	});

	it("does not transfer the private options binding to a copied options object", async () => {
		const fixture = await createFixture();
		fixture.harness.setResponses(fixture.responses());
		await fixture.present();
		const prompt = fixture.harness.session.prompt.bind(fixture.harness.session);
		vi.spyOn(fixture.harness.session, "prompt").mockImplementation((text, options) => prompt(text, { ...options }));
		fixture.host.defaultEditor.setText("Yes");
		fixture.terminal.sendInput("\r");
		fixture.startLoop();
		await fixture.completeReply();
		expect(fixture.replies).toEqual([undefined]);
	});

	it("does not transfer the private binding to another AgentSession", async () => {
		const first = await createFixture();
		const second = await createFixture();
		second.harness.setResponses(second.responses());
		await first.present();
		await second.present();
		vi.spyOn(first.harness.session, "prompt").mockImplementation((text, options) =>
			second.harness.session.prompt(text, options),
		);
		first.host.defaultEditor.setText("Yes");
		first.terminal.sendInput("\r");
		first.startLoop();
		await second.completeReply();
		expect(second.replies).toEqual([undefined]);
	});

	it.each(["clear", "abort"])("drops queued native input across %s", async (kind) => {
		const fixture = await createFixture();
		fixture.harness.setResponses(fixture.responses());
		await fixture.present();
		fixture.host.defaultEditor.setText("Yes");
		fixture.terminal.sendInput("\r");
		if (kind === "clear") fixture.harness.session.clearQueue();
		else await fixture.harness.session.abort();
		fixture.startLoop();
		await fixture.completeReply();
		expect(fixture.replies).toEqual([undefined]);
	});

	it("does not retain native input in the public string-only startup API", async () => {
		const fixture = await createFixture();
		fixture.harness.setResponses(fixture.responses());
		await fixture.present();
		fixture.host.defaultEditor.setText("Yes");
		fixture.terminal.sendInput("\r");
		expect(await fixture.mode.getUserInput()).toBe("Yes");
		await fixture.harness.session.prompt("Yes");
		expect(fixture.replies).toEqual([undefined]);
	});

	it("routes actual native follow-up input through the same fixed observer", async () => {
		const fixture = await createFixture();
		fixture.harness.setResponses(fixture.responses());
		await fixture.present();
		fixture.host.defaultEditor.setText(" Yes ");
		fixture.terminal.sendInput("\x1b\r");
		fixture.startLoop();
		await fixture.completeReply();
		expect(fixture.replies[0]?.originalText).toBe(" Yes ");
	});

	it.each(["\r", "\x1b\r"])("preserves queued native origin while a response is streaming (%j)", async (key) => {
		const fixture = await createFixture();
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		fixture.harness.setResponses([
			async () => {
				await held;
				return fauxAssistantMessage("First response");
			},
			...fixture.responses(),
		]);
		const running = fixture.harness.session.prompt("Initial prompt");
		try {
			await vi.waitFor(() => expect(fixture.harness.session.isStreaming).toBe(true));
			await fixture.present();
			fixture.host.defaultEditor.setText(" Yes ");
			fixture.terminal.sendInput(key);
			await vi.waitFor(() => expect(fixture.harness.session.agent.peekQueuedMessages()).toHaveLength(1));
			const preview = fixture.harness.session.agent.peekQueuedMessages()[0];
			release();
			await running;
			expect(fixture.replies[0]?.originalText).toBe(" Yes ");
			const delivered = fixture.harness.session.messages.findLast((message) => message.role === "user");
			expect(preview).toEqual(delivered);
			expect(preview).not.toBe(delivered);
		} finally {
			release();
			await running;
		}
	});

	it("does not revive a native queue receipt from restored text", async () => {
		const fixture = await createFixture();
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		fixture.harness.setResponses([
			async () => {
				await held;
				return fauxAssistantMessage("First response");
			},
			...fixture.responses(),
		]);
		const running = fixture.harness.session.prompt("Initial prompt");
		try {
			await vi.waitFor(() => expect(fixture.harness.session.isStreaming).toBe(true));
			await fixture.present();
			fixture.host.defaultEditor.setText("Yes");
			fixture.terminal.sendInput("\r");
			await vi.waitFor(() => expect(fixture.harness.session.getSteeringMessages()).toEqual(["Yes"]));
			const restored = fixture.harness.session.clearQueue();
			await fixture.harness.session.steer(restored.steering[0]);
			release();
			await running;
			expect(fixture.replies).toEqual([undefined]);
		} finally {
			release();
			await running;
		}
	});

	it("preserves native input while flushing the private compaction queue", async () => {
		const fixture = await createFixture();
		fixture.harness.setResponses(fixture.responses());
		await fixture.present();
		const compacting = vi.spyOn(fixture.harness.session, "isCompacting", "get").mockReturnValue(true);
		fixture.host.defaultEditor.setText(" Yes ");
		fixture.terminal.sendInput("\r");
		expect(fixture.host.getAllQueuedMessages()).toEqual({ steering: ["Yes"], followUp: [] });
		compacting.mockRestore();
		await fixture.host.flushCompactionQueue({ willRetry: false });
		expect(fixture.replies[0]?.originalText).toBe(" Yes ");
	});

	it("preserves steering behavior when flushing into an active agent run", async () => {
		const fixture = await createFixture();
		fixture.harness.setResponses([fauxAssistantMessage("Done")]);
		const compacting = vi.spyOn(fixture.harness.session, "isCompacting", "get").mockReturnValue(true);
		await fixture.host.defaultEditor.onSubmit?.("change direction");
		compacting.mockRestore();
		const prompt = vi.spyOn(fixture.harness.session, "prompt");
		const error = vi.spyOn(fixture.host, "showError");
		await fixture.host.flushCompactionQueue({ willRetry: false });
		expect(prompt).toHaveBeenCalledWith("change direction", { streamingBehavior: "steer" });
		expect(fixture.host.getAllQueuedMessages()).toEqual({ steering: [], followUp: [] });
		expect(error).not.toHaveBeenCalled();
	});

	it("queues a normal prompt submitted before the input callback is installed", async () => {
		const fixture = await createFixture();
		const history = vi.spyOn(fixture.host.defaultEditor, "addToHistory");
		await fixture.host.defaultEditor.onSubmit?.(" early prompt ");
		expect(await fixture.mode.getUserInput()).toBe("early prompt");
		expect(history).toHaveBeenCalledWith("early prompt");
	});

	it("returns queued startup input before installing the next callback", async () => {
		const fixture = await createFixture();
		await fixture.host.defaultEditor.onSubmit?.("first queued prompt");
		await fixture.host.defaultEditor.onSubmit?.("second queued prompt");
		expect(await fixture.mode.getUserInput()).toBe("first queued prompt");
		expect(await fixture.mode.getUserInput()).toBe("second queued prompt");
		const waiting = fixture.mode.getUserInput();
		await fixture.host.defaultEditor.onSubmit?.("later prompt");
		await expect(waiting).resolves.toBe("later prompt");
	});
});
