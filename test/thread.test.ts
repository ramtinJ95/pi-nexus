import { describe, expect, test } from "bun:test";
import { emptyView, isSettled, latestReply, reduce, type RenderedEntry, type ThreadState, type WatchEvent } from "../extensions/nexus/thread.ts";
import { assistant, idA, idle, reset, state, toolCall, toolResult, user, working } from "./fixtures.ts";

const view = (events: WatchEvent[]) => events.reduce(reduce, emptyView);
const aborted = (id: number): RenderedEntry => ({
	entry: { id, model: [{ role: "assistant", content: [], stopReason: "aborted" }] },
	text: "[aborted]",
});

describe("settling", () => {
	test("nothing settles before a state", () => {
		expect(isSettled(view([reset(idA, [user(1, "hi"), assistant(2, "Hello.")])]))).toBe(false);
	});

	test("an idle run settles once the last row is not the user's", () => {
		expect(isSettled(view([reset(idA, [user(1, "hi"), assistant(2, "Hello.")]), state(idA, idle)]))).toBe(true);
		expect(isSettled(view([reset(idA, [user(1, "hi")]), state(idA, idle)]))).toBe(false);
		expect(isSettled(view([reset(idA, []), state(idA, idle)]))).toBe(false);
	});

	test("working then idle settles even with the user's message last", () => {
		expect(isSettled(view([reset(idA, [user(1, "hi")]), state(idA, working), state(idA, idle)]))).toBe(true);
	});

	test("having worked does not settle a run still working or with something queued", () => {
		expect(isSettled(view([reset(idA, [user(1, "hi")]), state(idA, working), state(idA, { ...working, queued: 0 })]))).toBe(false);
		expect(isSettled(view([reset(idA, [user(1, "hi")]), state(idA, working), state(idA, { ...idle, queued: 1 })]))).toBe(false);
	});

	test("a failed pylon settles at once, even while the run is working", () => {
		expect(isSettled(view([reset(idA, [user(1, "hi")]), state(idA, { ...working, failed: "boot timed out" })]))).toBe(true);
		expect(isSettled(view([reset(idA, [user(1, "hi")]), state(idA, { ...working, pylon: "failed" } as ThreadState)]))).toBe(true);
	});

	test("parked, archived and deleted threads settle at once", () => {
		for (const s of [{ ...working, run: "parked" }, { ...working, status: "archived" }, { ...working, status: "deleted" }] as ThreadState[]) {
			expect(isSettled(view([reset(idA, [user(1, "hi")]), state(idA, s)]))).toBe(true);
		}
	});
});

describe("the reply", () => {
	test("an aborted latest turn gives no reply instead of the earlier answer", () => {
		expect(latestReply([user(1, "first"), assistant(2, "old answer"), user(3, "second"), aborted(4)])).toBeUndefined();
	});

	test("every assistant text since the last user message, a blank line apart", () => {
		expect(latestReply([user(1, "go"), assistant(2, "Build passed."), toolCall(3), toolResult(4), assistant(5, "Tests passed.")])).toBe("Build passed.\n\nTests passed.");
	});

	test("the text parts of one message count separately", () => {
		const twoParts: RenderedEntry = {
			entry: { id: 2, model: [{ role: "assistant", content: [{ type: "text", text: "One." }, { type: "text", text: "Two." }], stopReason: "stop" }] },
			text: "One.\nTwo.",
		};
		expect(latestReply([user(1, "go"), twoParts])).toBe("One.\n\nTwo.");
	});
});
