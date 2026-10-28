import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type StartupSubmitContext = {
	editor: { setText: (text: string) => void };
	showStatus: (message: string) => void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as {
	handleStartupSubmit(this: StartupSubmitContext, text: string): void;
};

describe("InteractiveMode startup input", () => {
	it("restores a prompt submitted while managed-tool setup is running", () => {
		const context: StartupSubmitContext = {
			editor: { setText: vi.fn() },
			showStatus: vi.fn(),
		};
		interactiveModePrototype.handleStartupSubmit.call(context, "early prompt");
		expect(context.editor.setText).toHaveBeenCalledWith("early prompt");
		expect(context.showStatus).toHaveBeenCalledWith("Startup is still in progress");
	});
});
