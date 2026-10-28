import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { captureTuiLifecycle } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const renderers = [
	{ name: "main", create: (terminal: VirtualTerminal) => new TuiMainScreen(terminal) },
	{ name: "alternate", create: (terminal: VirtualTerminal) => new TuiAltScreen(terminal) },
];

for (const renderer of renderers) {
	describe(`${renderer.name} native renderer lifetime`, () => {
		it("does not accept caller flags as a running lifetime", () => {
			assert.equal(captureTuiLifecycle({ started: true, stopped: false })(), false);
		});

		it("retires a capture permanently across stop and restart", () => {
			const tui = renderer.create(new VirtualTerminal());
			const beforeStart = captureTuiLifecycle(tui);
			try {
				assert.equal(beforeStart(), false);
				tui.start();
				const first = captureTuiLifecycle(tui);
				assert.equal(beforeStart(), false);
				assert.equal(first(), true);
				tui.stop();
				assert.equal(first(), false);
				tui.start();
				assert.equal(first(), false);
				assert.equal(captureTuiLifecycle(tui)(), true);
			} finally {
				tui.stop();
			}
		});

		it("has no running lifetime when terminal startup fails", () => {
			const terminal = new VirtualTerminal();
			const tui = renderer.create(terminal);
			terminal.start = () => {
				throw new Error("fixture startup failure");
			};
			try {
				assert.throws(() => tui.start(), /fixture startup failure/);
				assert.equal(captureTuiLifecycle(tui)(), false);
			} finally {
				tui.stop();
			}
		});

		it("retires the lifetime before a failing terminal stop", () => {
			const terminal = new VirtualTerminal();
			const tui = renderer.create(terminal);
			const stop = terminal.stop.bind(terminal);
			tui.start();
			const lifetime = captureTuiLifecycle(tui);
			terminal.stop = () => {
				stop();
				throw new Error("fixture stop failure");
			};
			try {
				assert.throws(() => tui.stop(), /fixture stop failure/);
				assert.equal(lifetime(), false);
				assert.equal(captureTuiLifecycle(tui)(), false);
			} finally {
				terminal.stop = stop;
				tui.stop();
			}
		});
	});
}
