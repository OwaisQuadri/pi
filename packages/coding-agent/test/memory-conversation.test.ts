import { describe, expect, it } from "vitest";
import {
	bindNativeMemoryConversationContext,
	bindNativeMemoryConversationRunner,
	getMemoryConversation,
	MemoryConversationController,
	type NativeMemoryConversationView,
	revokeNativeMemoryConversationRunner,
} from "../src/core/memory-conversation.ts";

const proposal = { id: "proposal-1", text: "Remember that the preferred example uses synthetic data." };

function createConversation(view: NativeMemoryConversationView = { isActive: () => true, present: () => () => true }) {
	const controller = new MemoryConversationController();
	const owner = {};
	const observe = controller.bindView(view);
	const conversation = controller.forTool(owner);
	return { controller, owner, observe, conversation };
}

describe("MemoryConversationController native-state units", () => {
	it("does not present or resolve without a native view", () => {
		const controller = new MemoryConversationController();
		const conversation = controller.forTool({});
		expect(conversation.present(proposal)).toBeUndefined();
		expect(conversation.resolveReply(proposal.id)).toBeUndefined();
	});

	it("keeps the exact proposal snapshot and original reply without an approval flag", () => {
		const { controller, observe, conversation } = createConversation();
		const draft = { ...proposal };
		const installed = conversation.present(draft);
		draft.text = "Changed after presentation";
		expect(installed).toEqual(proposal);
		expect(Object.isFrozen(installed)).toBe(true);
		const message = {};
		const token = observe("  Yes, remember that.  ", "Yes, remember that.");
		controller.associateInput(message, token, "Yes, remember that.");
		controller.activateInput(message);
		const reply = conversation.resolveReply(proposal.id);
		expect(reply).toEqual({
			proposalId: proposal.id,
			originalText: "  Yes, remember that.  ",
			submittedText: "Yes, remember that.",
		});
		expect(Object.isFrozen(reply)).toBe(true);
		expect(conversation.resolveReply(proposal.id)).toBeUndefined();
	});

	it("rejects serialized source and approval flags", () => {
		const { controller, conversation } = createConversation();
		conversation.present(proposal);
		const message = {};
		controller.associateInput(message, { source: "interactive", mode: "tui", approved: true }, "Yes");
		controller.activateInput(message);
		expect(conversation.resolveReply(proposal.id)).toBeUndefined();
	});

	it("does not use an observed reply before its actual message is activated", () => {
		const { controller, observe, conversation } = createConversation();
		conversation.present(proposal);
		const message = {};
		controller.associateInput(message, observe("Yes", "Yes"), "Yes");
		expect(conversation.resolveReply(proposal.id)).toBeUndefined();
		controller.activateInput(message);
		expect(conversation.resolveReply(proposal.id)?.originalText).toBe("Yes");
	});

	it("rejects copied tokens and consumes a token before accepting its routed text", () => {
		const { controller, observe, conversation } = createConversation();
		conversation.present(proposal);
		const token = observe("Yes", "Yes");
		const forged = {};
		controller.associateInput(forged, { ...token }, "Yes");
		controller.activateInput(forged);
		expect(conversation.resolveReply(proposal.id)).toBeUndefined();
		const changed = {};
		controller.associateInput(changed, token, "A transformed value");
		controller.activateInput(changed);
		expect(conversation.resolveReply(proposal.id)).toBeUndefined();
		const replay = {};
		controller.associateInput(replay, token, "Yes");
		controller.activateInput(replay);
		expect(conversation.resolveReply(proposal.id)).toBeUndefined();
	});

	it("does not transfer a native input between sessions", () => {
		const first = createConversation();
		const second = createConversation();
		first.conversation.present(proposal);
		second.conversation.present(proposal);
		const token = first.observe("Yes", "Yes");
		const message = {};
		second.controller.associateInput(message, token, "Yes");
		second.controller.activateInput(message);
		expect(second.conversation.resolveReply(proposal.id)).toBeUndefined();
	});

	it("binds a proposal to the actual tool owner rather than its id", () => {
		const { controller, observe, conversation } = createConversation();
		conversation.present(proposal);
		const message = {};
		controller.associateInput(message, observe("Yes", "Yes"), "Yes");
		controller.activateInput(message);
		expect(controller.forTool({}).resolveReply(proposal.id)).toBeUndefined();
		expect(conversation.resolveReply("different-proposal")).toBeUndefined();
		expect(conversation.resolveReply(proposal.id)?.originalText).toBe("Yes");
	});

	it("does not transfer an old reply to an amended proposal", () => {
		const { controller, observe, conversation } = createConversation();
		conversation.present(proposal);
		const message = {};
		controller.associateInput(message, observe("Yes", "Yes"), "Yes");
		conversation.present({ ...proposal, text: "An amended proposal" });
		controller.activateInput(message);
		expect(conversation.resolveReply(proposal.id)).toBeUndefined();
	});

	it("rejects a reply observed before or during presentation", () => {
		let during: object | undefined;
		let observe: (originalText: string, submittedText: string) => object | undefined = () => undefined;
		const setup = createConversation({
			isActive: () => true,
			present: () => {
				during = observe("Yes", "Yes");
				return () => true;
			},
		});
		observe = setup.observe;
		const before = observe("Yes", "Yes");
		setup.conversation.present(proposal);
		for (const token of [before, during]) {
			const message = {};
			setup.controller.associateInput(message, token, "Yes");
			setup.controller.activateInput(message);
			expect(setup.conversation.resolveReply(proposal.id)).toBeUndefined();
		}
	});

	it("rejects no-op, stopped and failed presentation", () => {
		for (const view of [
			{ isActive: () => false, present: () => () => true },
			{ isActive: () => true, present: () => undefined },
			{ isActive: () => true, present: () => () => false },
			{
				isActive: () => true,
				present: () => {
					throw new Error("Synthetic render failure");
				},
			},
		]) {
			const { conversation, observe } = createConversation(view);
			expect(conversation.present(proposal)).toBeUndefined();
			expect(observe("Yes", "Yes")).toBeUndefined();
		}
	});

	it("checks that the complete proposal remains installed at consumption", () => {
		let isInstalled = true;
		const { controller, observe, conversation } = createConversation({
			isActive: () => true,
			present: () => () => isInstalled,
		});
		conversation.present(proposal);
		const message = {};
		controller.associateInput(message, observe("Yes", "Yes"), "Yes");
		controller.activateInput(message);
		isInstalled = false;
		expect(conversation.resolveReply(proposal.id)).toBeUndefined();
		isInstalled = true;
		expect(conversation.resolveReply(proposal.id)).toBeUndefined();
		expect(observe("Yes", "Yes")).toBeUndefined();
	});

	it("revokes saved methods and queued messages on replacement", () => {
		const { controller, observe, conversation } = createConversation();
		conversation.present(proposal);
		const saved = conversation.resolveReply;
		const message = {};
		controller.associateInput(message, observe("Yes", "Yes"), "Yes");
		controller.bindView({ isActive: () => true, present: () => () => true });
		controller.activateInput(message);
		expect(saved(proposal.id)).toBeUndefined();
		expect(conversation.present(proposal)).toBeUndefined();
		expect(observe("Yes", "Yes")).toBeUndefined();
	});

	it("does not re-arm a proposal after reentrant invalidation during installation", () => {
		const controller = new MemoryConversationController();
		const observe = controller.bindView({
			isActive: () => true,
			present: () => () => {
				controller.invalidate();
				return true;
			},
		});
		const conversation = controller.forTool({});
		expect(conversation.present(proposal)).toBeUndefined();
		expect(observe("Yes", "Yes")).toBeUndefined();
	});

	it("closes the current reply when another user message becomes active", () => {
		const { controller, observe, conversation } = createConversation();
		conversation.present(proposal);
		const message = {};
		controller.associateInput(message, observe("Yes", "Yes"), "Yes");
		controller.activateInput(message);
		controller.activateInput({});
		expect(conversation.resolveReply(proposal.id)).toBeUndefined();
		controller.activateInput(message);
		expect(conversation.resolveReply(proposal.id)).toBeUndefined();
	});
});

describe("Native memory tool-context identity units", () => {
	it("does not trust a context facade, mode or SDK-shaped flags", () => {
		const fake = {
			mode: "tui",
			memoryConversation: { present: () => proposal, resolveReply: () => ({ approved: true }) },
		};
		expect(getMemoryConversation(fake)).toBeUndefined();
		expect(getMemoryConversation(Object.create(fake))).toBeUndefined();
	});

	it("does not mint a facade for an unbound runner", () => {
		const context = {};
		bindNativeMemoryConversationContext(context, {}, {});
		expect(getMemoryConversation(context)).toBeUndefined();
	});

	it("binds only the actual native context object and tool owner", () => {
		const { controller, owner, observe } = createConversation();
		const runner = {};
		const context = {};
		bindNativeMemoryConversationRunner(runner, controller);
		bindNativeMemoryConversationContext(context, runner, owner);
		const conversation = getMemoryConversation(context);
		expect(conversation?.present(proposal)).toEqual(proposal);
		expect(getMemoryConversation({ ...context })).toBeUndefined();
		const message = {};
		controller.associateInput(message, observe("Yes", "Yes"), "Yes");
		controller.activateInput(message);
		const otherContext = {};
		bindNativeMemoryConversationContext(otherContext, runner, {});
		expect(getMemoryConversation(otherContext)?.resolveReply(proposal.id)).toBeUndefined();
		expect(conversation?.resolveReply(proposal.id)?.originalText).toBe("Yes");
	});

	it("revokes a saved facade before shutdown side effects", () => {
		const { controller, owner, observe } = createConversation();
		const runner = {};
		const context = {};
		bindNativeMemoryConversationRunner(runner, controller);
		bindNativeMemoryConversationContext(context, runner, owner);
		const conversation = getMemoryConversation(context);
		conversation?.present(proposal);
		const message = {};
		controller.associateInput(message, observe("Yes", "Yes"), "Yes");
		controller.activateInput(message);
		revokeNativeMemoryConversationRunner(runner);
		expect(conversation?.resolveReply(proposal.id)).toBeUndefined();
		expect(conversation?.present(proposal)).toBeUndefined();
	});
});
