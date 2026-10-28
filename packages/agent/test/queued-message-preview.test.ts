import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type UserMessage,
} from "@earendil-works/pi-ai/compat";
import { Agent } from "../src/agent.ts";

describe("queued message identity", () => {
	for (const queue of ["steer", "followUp"] as const) {
		it(`keeps the original ${queue} message private until native delivery`, async () => {
			const original: UserMessage = { role: "user", content: "queued input", timestamp: 1 };
			const agent = new Agent({
				streamFn: () => {
					const stream = createAssistantMessageEventStream();
					queueMicrotask(() => {
						stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("Done") });
					});
					return stream;
				},
			});
			agent[queue](original);
			const preview = agent.peekQueuedMessages()[0];
			assert.deepEqual(preview, original);
			assert.notEqual(preview, original);
			assert.notEqual(agent.peekQueuedMessages()[0], preview);
			let delivered: object | undefined;
			agent.subscribe((event) => {
				if (event.type === "message_start" && event.message === original) delivered = event.message;
			});
			await agent.prompt("start");
			assert.equal(delivered, original);
		});
	}
});
