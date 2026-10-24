import { describe, expect, test } from "bun:test";
import { follow } from "../extensions/nexus/follow.ts";
import type { Note } from "../extensions/nexus/render.ts";
import type { WatchEvent } from "../extensions/nexus/contract.ts";
import { assistant, entry, head, idA, idle, reset, scriptedNexus, state, toolCall, toolResult, user, working } from "./fixtures.ts";

function run(polls: WatchEvent[][], nextTurn: boolean, signal = new AbortController().signal) {
	const notes: Note[] = [];
	const states: string[] = [];
	const sink = { note: (n: Note) => notes.push(n), state: (v: { state?: { run: string } }) => states.push(v.state!.run) };
	return { notes, states, end: follow(scriptedNexus(polls), idA, sink, signal, nextTurn) };
}

describe("follow", () => {
	test("an explicit follow of an idle thread shows recent context and waits for its next turn", async () => {
		const f = run(
			[
				[reset(idA, [user(1, "one"), assistant(2, "two"), head, user(3, "three"), assistant(4, "four")]), state(idA, idle)],
				[entry(idA, user(5, "five")), state(idA, working)],
				[entry(idA, head), entry(idA, toolCall(6))],
				[entry(idA, assistant(7, "done")), state(idA, idle)],
			],
			true,
		);
		expect(await f.end).toBe("answered");
		expect(f.notes[0]).toEqual({ title: `following ${idA}`, body: "two\n\n> three\n\nfour" });
		expect(f.notes.slice(1).map((n) => n.body)).toEqual(["> five", "[tool] bash {}", "done"]);
		expect(f.states).toEqual(["idle", "working", "idle"]);
	});

	test("a follow after a send takes a reply that came before the first poll", async () => {
		const f = run([[reset(idA, [user(1, "hi"), assistant(2, "Hello.")]), state(idA, idle)]], false);
		expect(await f.end).toBe("answered");
		expect(f.notes.map((n) => n.body)).toEqual(["> hi\n\nHello."]);
	});

	test("entries are judged with the state of their own poll", async () => {
		const f = run(
			[
				[reset(idA, []), state(idA, { ...idle, pylon: "booting" })],
				[entry(idA, user(1, "one")), entry(idA, assistant(2, "two")), entry(idA, user(3, "three")), state(idA, working)],
				[entry(idA, assistant(4, "four")), state(idA, idle)],
			],
			false,
		);
		expect(await f.end).toBe("answered");
		expect(f.notes.at(-1)!.body).toBe("four");
	});

	test("a turn that ends on a tool call ends the follow", async () => {
		const f = run([[reset(idA, [user(1, "hi")]), state(idA, working)], [entry(idA, toolCall(2)), entry(idA, toolResult(3)), state(idA, idle)]], true);
		expect(await f.end).toBe("answered");
	});

	test("an explicit follow counts a rewritten context as the turn it waits for", async () => {
		const f = run([[reset(idA, [user(1, "hi"), assistant(2, "Hello.")]), state(idA, idle)], [reset(idA, [user(1, "hi"), assistant(2, "Hello."), user(3, "more"), assistant(4, "Done.")])]], true);
		expect(await f.end).toBe("answered");
		expect(f.notes.at(-1)!.title).toBe(`${idA} conversation was rewritten`);
	});

	test("a run that worked and went idle without writing anything ends the follow", async () => {
		const f = run([[reset(idA, [user(1, "hi")]), state(idA, working)], [state(idA, idle)]], true);
		expect(await f.end).toBe("answered");
	});

	test("a failed pylon ends the follow at once", async () => {
		const f = run([[reset(idA, [user(1, "hi")]), state(idA, { ...working, failed: "boot timed out" })]], true);
		expect(await f.end).toBe("failed");
	});

	test("a thread that needs a human ends the follow at once", async () => {
		const f = run([[reset(idA, [user(1, "hi")]), state(idA, { ...working, run: "parked", parkedTasks: 1 })]], true);
		expect(await f.end).toBe("parked");
	});

	test("an outage is shown and the follow goes on", async () => {
		const f = run(
			[
				[reset(idA, [user(1, "hi")]), state(idA, working)],
				[{ type: "error", thread: idA, kind: "unreachable", message: "proxy down" }],
				[entry(idA, assistant(2, "back")), state(idA, idle)],
			],
			false,
		);
		expect(await f.end).toBe("answered");
		expect(f.notes[1]).toEqual({ title: idA, body: "Nexus is unreachable: proxy down. Still watching.", error: true });
	});

	test("stopping ends the follow", async () => {
		const stop = new AbortController();
		const f = run([[reset(idA, []), state(idA, idle)]], true, stop.signal);
		stop.abort();
		expect(await f.end).toBe("stopped");
	});
});
