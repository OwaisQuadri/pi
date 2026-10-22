import assert from "node:assert";
import { describe, it } from "node:test";
import type { AutocompleteProvider } from "../src/autocomplete.ts";
import { Editor } from "../src/components/editor.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

async function flushAutocomplete(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

function createFixture(triggerCharacters?: string[]) {
	const editor = new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
	const requests: string[] = [];
	const submissions: string[] = [];
	const provider: AutocompleteProvider = {
		triggerCharacters,
		getSuggestions: async (lines, cursorLine, cursorCol) => {
			requests.push(lines[cursorLine]!.slice(0, cursorCol));
			return {
				prefix: "inline-skill",
				items: [{ value: "/skill:example", label: "example" }],
			};
		},
		applyCompletion: (lines, cursorLine, cursorCol, item) => {
			const line = lines[cursorLine]!;
			const start = line.lastIndexOf("/", cursorCol - 1);
			const updated = [...lines];
			updated[cursorLine] = line.slice(0, start) + item.value + line.slice(cursorCol);
			return { lines: updated, cursorLine, cursorCol: start + item.value.length };
		},
	};
	editor.setAutocompleteProvider(provider);
	editor.onSubmit = (text) => submissions.push(text);
	return { editor, provider, requests, submissions };
}

describe("Editor slash trigger", () => {
	it("automatically opens and debounces explicitly registered inline slash suggestions", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const { editor, requests, submissions } = createFixture(["/"]);
		t.after(() => editor.setText(""));
		editor.setText("use ");
		for (const character of "/mode") editor.handleInput(character);

		t.mock.timers.tick(19);
		await flushAutocomplete();
		assert.deepStrictEqual(requests, []);
		assert.strictEqual(editor.isShowingAutocomplete(), false);

		t.mock.timers.tick(1);
		await flushAutocomplete();
		assert.deepStrictEqual(requests, ["use /mode"]);
		assert.strictEqual(editor.isShowingAutocomplete(), true);

		editor.handleInput("\r");
		assert.strictEqual(editor.getText(), "use /skill:example");
		assert.strictEqual(editor.isShowingAutocomplete(), false);
		assert.deepStrictEqual(submissions, []);
	});

	it("keeps inline slash opt-in and resets it when the provider changes", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		for (const triggers of [undefined, ["/"]]) {
			const { editor, provider, requests } = createFixture(triggers);
			editor.setAutocompleteProvider({ ...provider, triggerCharacters: undefined });
			editor.setText("use ");
			for (const character of "/mode") editor.handleInput(character);
			t.mock.timers.tick(20);
			await flushAutocomplete();
			assert.deepStrictEqual(requests, []);
			assert.strictEqual(editor.isShowingAutocomplete(), false);
		}
	});

	it("does not treat slashes inside paths or URLs as token starts", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const { editor, requests } = createFixture(["/"]);
		for (const text of ["use src/file", "use ./file", "use https://example.com/file"]) {
			editor.setText("");
			for (const character of text) editor.handleInput(character);
			t.mock.timers.tick(20);
			await flushAutocomplete();
			assert.deepStrictEqual(requests, [], text);
			assert.strictEqual(editor.isShowingAutocomplete(), false);
		}
	});

	it("keeps leading slash commands automatic without registering slash", async () => {
		const { editor, requests } = createFixture();
		editor.handleInput("/");
		await flushAutocomplete();
		assert.deepStrictEqual(requests, ["/"]);
		assert.strictEqual(editor.isShowingAutocomplete(), true);
		editor.setText("");
	});
});
