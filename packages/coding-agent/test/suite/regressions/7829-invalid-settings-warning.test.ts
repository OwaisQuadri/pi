import type { Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import type { AgentSessionRuntimeDiagnostic } from "../../../src/core/agent-session-services.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { createHarness } from "../harness.ts";

function render(container: Container): string {
	return container.children.flatMap((child) => child.render(120)).join("\n");
}

describe("issue #7829 invalid settings warning", () => {
	beforeAll(() => initTheme("dark"));

	it("renders startup diagnostics inside the transcript", async () => {
		const harness = await createHarness({ settings: { tuiMode: "regular" } });
		vi.stubEnv("PI_OFFLINE", "1");
		vi.stubEnv(ENV_AGENT_DIR, harness.tempDir);
		const runtime = new AgentSessionRuntime(
			harness.session,
			{
				cwd: harness.tempDir,
				agentDir: harness.tempDir,
				modelRuntime: harness.session.modelRuntime,
				settingsManager: harness.settingsManager,
				resourceLoader: harness.session.resourceLoader,
				diagnostics: [],
			},
			async () => {
				throw new Error("The startup fixture does not replace sessions");
			},
		);
		const startupDiagnostics: AgentSessionRuntimeDiagnostic[] = [
			{ type: "warning", message: "Invalid settings file /tmp/settings.json: malformed JSON" },
		];
		const mode = new InteractiveMode(runtime, {
			terminal: new VirtualTerminal(),
			startupDiagnostics,
			initialMessage: "End startup fixture",
		});
		const host = mode as unknown as { chatContainer: Container; showError(message: string): void };
		const stop = new Error("Synthetic startup fixture exit");
		const prompt = vi.spyOn(harness.session, "prompt").mockRejectedValue(stop);
		const showError = vi.spyOn(host, "showError").mockImplementation((message) => {
			expect(message).toBe(stop.message);
			throw stop;
		});
		try {
			await expect(mode.run()).rejects.toBe(stop);
			expect(render(host.chatContainer)).toContain(
				"Warning: Invalid settings file /tmp/settings.json: malformed JSON",
			);
			expect(prompt).toHaveBeenCalledWith("End startup fixture", { images: undefined });
			expect(showError).toHaveBeenCalledTimes(1);
		} finally {
			try {
				mode.stop();
				await runtime.dispose();
			} finally {
				vi.restoreAllMocks();
				vi.unstubAllEnvs();
				harness.cleanup();
			}
		}
	});
});
