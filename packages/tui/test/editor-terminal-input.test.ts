import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { Editor, type EditorOptions } from "../src/components/editor.ts";
import { getKeybindings } from "../src/keybindings.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function createFixture(context: TestContext, onTerminalSubmit?: EditorOptions["onTerminalSubmit"]) {
	const terminal = new VirtualTerminal();
	const tui = new TuiMainScreen(terminal);
	const observed: [string, string][] = [];
	const submitted: string[] = [];
	const editor = new Editor(tui, defaultEditorTheme, {
		onTerminalSubmit: (text, submittedText) => {
			observed.push([text, submittedText]);
			return onTerminalSubmit?.(text, submittedText);
		},
	});
	editor.onSubmit = (text) => submitted.push(text);
	tui.addChild(editor);
	tui.setFocus(editor);
	tui.start();
	context.after(() => tui.stop());
	return { terminal, tui, editor, observed, submitted };
}

describe("Editor terminal submission origin", () => {
	it("observes the unchanged terminal submission before trimming", (context) => {
		const { terminal, editor, observed, submitted } = createFixture(context);
		editor.setText(" approve ");
		terminal.sendInput("\r");
		assert.deepEqual(observed, [[" approve ", "approve"]]);
		assert.deepEqual(submitted, ["approve"]);
	});

	it("observes backslash submission before the native editor transformation", (context) => {
		const { terminal, editor, observed, submitted } = createFixture(context);
		const bindings = getKeybindings();
		const previous = bindings.getUserBindings();
		bindings.setUserBindings({ ...previous, "tui.input.submit": "shift+enter", "tui.input.newLine": "enter" });
		context.after(() => bindings.setUserBindings(previous));
		editor.setText("yes\\");
		terminal.sendInput("\r");
		assert.deepEqual(observed, [["yes\\", "yes"]]);
		assert.deepEqual(submitted, ["yes"]);
	});

	it("rejects listener text changes on backslash submission", (context) => {
		const { terminal, tui, editor, observed, submitted } = createFixture(context);
		const bindings = getKeybindings();
		const previous = bindings.getUserBindings();
		bindings.setUserBindings({ ...previous, "tui.input.submit": "shift+enter", "tui.input.newLine": "enter" });
		context.after(() => bindings.setUserBindings(previous));
		editor.setText("ordinary\\");
		tui.addInputListener(() => {
			editor.setText("changed\\");
		});
		terminal.sendInput("\r");
		assert.deepEqual(observed, []);
		assert.deepEqual(submitted, ["changed"]);
	});

	it("does not grant origin to programmatic backslash submission", (context) => {
		const { editor, observed, submitted } = createFixture(context);
		const bindings = getKeybindings();
		const previous = bindings.getUserBindings();
		bindings.setUserBindings({ ...previous, "tui.input.submit": "shift+enter", "tui.input.newLine": "enter" });
		context.after(() => bindings.setUserBindings(previous));
		editor.setText("yes\\");
		editor.handleInput("\r");
		assert.deepEqual(observed, []);
		assert.deepEqual(submitted, ["yes"]);
	});

	it("does not observe calls to the public submit callback", (context) => {
		const { editor, observed, submitted } = createFixture(context);
		editor.onSubmit?.("approve");
		assert.deepEqual(observed, []);
		assert.deepEqual(submitted, ["approve"]);
	});

	it("does not observe programmatic editor input", (context) => {
		const { editor, observed, submitted } = createFixture(context);
		editor.setText("approve");
		editor.handleInput("\r");
		assert.deepEqual(observed, []);
		assert.deepEqual(submitted, ["approve"]);
	});

	it("does not carry an unrelated terminal event into later programmatic input", (context) => {
		const { terminal, editor, observed, submitted } = createFixture(context);
		terminal.sendInput("approve");
		editor.handleInput("\r");
		assert.deepEqual(observed, []);
		assert.deepEqual(submitted, ["approve"]);
	});

	it("does not turn transformed terminal data into a native submission", (context) => {
		const { terminal, tui, editor, observed, submitted } = createFixture(context);
		editor.setText("approve");
		tui.addInputListener(() => ({ data: "\r" }));
		terminal.sendInput("x");
		assert.deepEqual(observed, []);
		assert.deepEqual(submitted, ["approve"]);
	});

	it("does not trust editor text changed by an input listener", (context) => {
		const { terminal, tui, editor, observed, submitted } = createFixture(context);
		editor.setText("ordinary text");
		tui.addInputListener(() => {
			editor.setText("approve");
		});
		terminal.sendInput("\r");
		assert.deepEqual(observed, []);
		assert.deepEqual(submitted, ["approve"]);
	});

	it("does not transfer terminal origin to a newly focused editor", (context) => {
		const { terminal, tui, editor, observed, submitted } = createFixture(context);
		editor.setText("ordinary text");
		const other = new Editor(tui, defaultEditorTheme, {
			onTerminalSubmit: (text, submittedText) => {
				observed.push([text, submittedText]);
				return undefined;
			},
		});
		other.setText("approve");
		other.onSubmit = (text) => submitted.push(text);
		tui.addChild(other);
		tui.addInputListener(() => {
			tui.setFocus(other);
		});
		terminal.sendInput("\r");
		assert.deepEqual(observed, []);
		assert.deepEqual(submitted, ["approve"]);
	});

	it("does not retain a consumed terminal event", (context) => {
		const { terminal, tui, editor, observed, submitted } = createFixture(context);
		editor.setText("approve");
		tui.addInputListener(() => ({ consume: true }));
		terminal.sendInput("\r");
		editor.handleInput("\r");
		assert.deepEqual(observed, []);
		assert.deepEqual(submitted, ["approve"]);
	});

	it("consumes origin before public change callbacks can reenter the editor", (context) => {
		const { terminal, editor, observed, submitted } = createFixture(context);
		editor.setText("approve");
		let isReentered = false;
		editor.onChange = () => {
			if (isReentered) return;
			isReentered = true;
			editor.setText("approve");
			editor.handleInput("\r");
		};
		terminal.sendInput("\r");
		assert.deepEqual(observed, [["approve", "approve"]]);
		assert.deepEqual(submitted, ["approve", "approve"]);
	});

	it("clears origin if the focused input handler throws", (context) => {
		const { terminal, editor, observed, submitted } = createFixture(context);
		editor.setText("approve");
		const handleInput = editor.handleInput.bind(editor);
		editor.handleInput = () => {
			throw new Error("input failed");
		};
		assert.throws(() => terminal.sendInput("\r"), /input failed/);
		editor.handleInput = handleInput;
		editor.handleInput("\r");
		assert.deepEqual(observed, []);
		assert.deepEqual(submitted, ["approve"]);
	});

	it("retains the pre-expansion paste marker separately from submitted content", (context) => {
		const { terminal, editor, observed, submitted } = createFixture(context);
		const pasted = "ordinary pasted text\n".repeat(20);
		terminal.sendInput(`\x1b[200~${pasted}\x1b[201~`);
		const original = editor.getText();
		assert.match(original, /^\[paste #1 /);
		terminal.sendInput("\r");
		assert.deepEqual(observed, [[original, pasted.trim()]]);
		assert.deepEqual(submitted, [pasted.trim()]);
	});

	it("does not expose a pending origin outside focused terminal dispatch", (context) => {
		const { terminal, tui, editor, observed } = createFixture(context);
		editor.setText("approve");
		assert.equal(tui.consumeTerminalInput(editor, "\r", "approve"), undefined);
		terminal.sendInput("\r");
		assert.deepEqual(observed, [["approve", "approve"]]);
		assert.equal(tui.consumeTerminalInput(editor, "\r", "approve"), undefined);
	});

	it("releases a native scope after synchronous submission", (context) => {
		let scope: object | undefined;
		let releaseCount = 0;
		const fixture = createFixture(context, () => {
			const current = {};
			scope = current;
			return () => {
				releaseCount++;
				if (scope === current) scope = undefined;
			};
		});
		let claimed: object | undefined;
		fixture.editor.onSubmit = () => {
			claimed = scope;
		};
		fixture.editor.setText("approve");
		fixture.terminal.sendInput("\r");
		assert.notEqual(claimed, undefined);
		assert.equal(scope, undefined);
		assert.equal(releaseCount, 1);
	});

	it("releases a suppressed scope before an asynchronous forward", async (context) => {
		let scope: object | undefined;
		const fixture = createFixture(context, () => {
			scope = {};
			return () => {
				scope = undefined;
			};
		});
		let claimed: object | undefined = {};
		fixture.editor.onSubmit = () => {
			queueMicrotask(() => {
				claimed = scope;
			});
		};
		fixture.editor.setText("approve");
		fixture.terminal.sendInput("\r");
		assert.equal(scope, undefined);
		await Promise.resolve();
		assert.equal(claimed, undefined);
	});

	it("clears an outer scope before a nested programmatic submit", (context) => {
		let scope: object | undefined;
		const fixture = createFixture(context, () => {
			scope = {};
			return () => {
				scope = undefined;
			};
		});
		const claims: Array<object | undefined> = [];
		fixture.editor.onSubmit = () => {
			claims.push(scope);
		};
		fixture.editor.setText("approve");
		let isReentered = false;
		fixture.editor.onChange = () => {
			if (isReentered) return;
			isReentered = true;
			fixture.editor.setText("nested");
			fixture.editor.handleInput("\r");
		};
		fixture.terminal.sendInput("\r");
		assert.deepEqual(claims, [undefined, undefined]);
		assert.equal(scope, undefined);
	});

	it("does not observe a backslash frame retired by a reentrant change callback", (context) => {
		const fixture = createFixture(context);
		const bindings = getKeybindings();
		const previous = bindings.getUserBindings();
		bindings.setUserBindings({ ...previous, "tui.input.submit": "shift+enter", "tui.input.newLine": "enter" });
		context.after(() => bindings.setUserBindings(previous));
		fixture.editor.setText("approve\\");
		let isReentered = false;
		fixture.editor.onChange = () => {
			if (isReentered) return;
			isReentered = true;
			fixture.editor.setText("nested");
			fixture.editor.handleInput("\r");
		};
		fixture.terminal.sendInput("\r");
		assert.deepEqual(fixture.observed, []);
	});

	it("releases a native scope when a public change callback throws", (context) => {
		let scope: object | undefined;
		const fixture = createFixture(context, () => {
			scope = {};
			return () => {
				scope = undefined;
			};
		});
		fixture.editor.setText("approve");
		fixture.editor.onChange = () => {
			throw new Error("Synthetic change failure");
		};
		assert.throws(() => fixture.terminal.sendInput("\r"), /Synthetic change failure/);
		assert.equal(scope, undefined);
	});
});
