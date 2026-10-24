/** The console through the extension's /nexus command, a fake ui.custom and the fake nexus binary. */
import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { createNexus, listThreads, showThread } from "../extensions/nexus/cli.ts";
import nexusExtension from "../extensions/nexus/index.ts";
import { detail, display, entries, fakeTui, keybindings, live, piTheme, plain, runningCall, working } from "./console-fixture.ts";
import { fakeNexus, idA, idB, reset, state, threads, type Scenario } from "./fixtures.ts";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

const projects = [{ id: "acme", repoUrl: "git@example.com:acme", defaultNode: "firebat", defaultBranch: "main" }];
const scenario: Scenario = {
	responses: { threads, projects, nodes: [{ name: "firebat", tailnetHost: "firebat.example", state: "online" }], show: detail, wake: null, send: { submission: 1 }, start: threads[0] },
	watch: [{ event: reset(idA, entries) }, { event: state(idA, working) }, { event: { type: "live", thread: idA, ...live } }],
	watchHold: true,
};

interface Shown {
	component: Component;
	options: unknown;
	done(result: unknown): void;
}

/** `custom` false stands in for a pi without custom UI, such as RPC mode, whose custom() never calls the factory. */
function load(s: Scenario, { custom = true } = {}) {
	const fake = fakeNexus(s);
	const notes: { title: string; body: string }[] = [];
	const notified: [string, string | undefined][] = [];
	const shown: Shown[] = [];
	const handlers = new Map<string, () => void>();
	let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	const pi = {
		registerEntryRenderer() {},
		registerTool() {},
		registerCommand: (_name: string, options: { handler: typeof command }) => (command = options.handler),
		on: (event: string, handler: () => void) => handlers.set(event, handler),
		appendEntry: (_type: string, note: (typeof notes)[number]) => notes.push(note),
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: true,
		cwd: "/tmp",
		ui: {
			notify: (message: string, type?: string) => notified.push([message, type]),
			setStatus() {},
			setWidget() {},
			custom: (factory: (...args: unknown[]) => Component & { dispose?(): void }, options: unknown) =>
				custom
					? new Promise((resolve) => {
							const entry: Shown = { component: undefined as never, options, done: () => {} };
							entry.done = (result) => {
								(entry.component as { dispose?(): void }).dispose?.();
								resolve(result);
							};
							entry.component = factory(fakeTui(50, 100), piTheme(), keybindings(), entry.done);
							(entry.component as { focused?: boolean }).focused = true;
							shown.push(entry);
						})
					: Promise.resolve(undefined),
		},
	} as unknown as ExtensionCommandContext;
	nexusExtension(pi, createNexus(fake.bin), display);
	cleanups.push(() => handlers.get("session_shutdown")?.(), fake.cleanup);
	const until = async (check: () => boolean, what: string) => {
		for (let i = 0; i < 150 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
		if (!check()) throw new Error(`timed out waiting for ${what}`);
	};
	const text = (i = shown.length - 1) => plain(shown[i]!.component.render(100));
	const type = (input: string, i = shown.length - 1) => {
		for (const ch of input) shown[i]!.component.handleInput!(ch);
		shown[i]!.component.handleInput!("\r");
	};
	return { run: (args: string) => command!(args, ctx), calls: fake.calls, notes, notified, shown, until, text, type };
}

describe("console", () => {
	test("/nexus open fills the screen with the thread, records the visit and sends with a request ID", async () => {
		const n = load(scenario);
		const done = n.run(`open ${idA}`);
		await n.until(() => n.shown.length === 1 && n.text().includes("Queued: also update the docs"), "the thread view");
		expect(n.shown[0]!.options).toEqual({ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left" } });
		expect(n.text()).toContain("I'll read the probe first.");
		await n.until(() => n.text().includes("nexus / Fix the probe retry"), "the detail");
		expect(n.calls()).toContainEqual(["wake", "--json", idA]);
		expect(n.calls()).toContainEqual(["show", "--json", idA]);
		expect(n.calls()).toContainEqual(["nodes", "--json"]);
		n.type("hello there");
		await n.until(() => n.calls().some((c) => c[0] === "send"), "the send");
		const send = n.calls().find((c) => c[0] === "send")!;
		expect(send.slice(0, 3)).toEqual(["send", "--json", idA]);
		expect(send[3]).toMatch(/^--request-id=msg:[0-9a-f-]{36}$/);
		expect(send.slice(4)).toEqual(["--", "hello there"]);
		n.shown[0]!.component.handleInput!("\x1b");
		await done;
		await n.until(() => n.calls().some((c) => c[0] === "<watch ended>"), "the watch to end");
	});

	test("an action runs the CLI command and refreshes the detail", async () => {
		const n = load({ ...scenario, responses: { ...scenario.responses, archive: detail.thread } });
		void n.run(`open ${idA}`);
		await n.until(() => n.shown.length === 1 && n.text().includes("nexus / Fix"), "the thread view");
		const shows = () => n.calls().filter((c) => c[0] === "show").length;
		const before = shows();
		n.type("/archive");
		await n.until(() => n.text().includes("Archived the thread."), "the archive");
		expect(n.calls()).toContainEqual(["archive", "--json", idA]);
		await n.until(() => shows() > before, "a refreshed detail");
		n.shown[0]!.done({ kind: "close" });
	});

	test("/open runs nexus preview --wait, links the port and refreshes the detail", async () => {
		const url = "https://firebat.example.ts.net:8445/";
		const n = load({ ...scenario, responses: { ...scenario.responses, preview: { pylon: "py-0123", service: "port-8080", httpsPort: 8445, ready: true, url } } });
		void n.run(`open ${idA}`);
		await n.until(() => n.shown.length === 1 && n.text().includes("nexus / Fix"), "the thread view");
		const shows = () => n.calls().filter((c) => c[0] === "show").length;
		const before = shows();
		n.type("/open 8080");
		await n.until(() => n.text().includes(`Port 8080 is open at ${url}`), "the preview");
		expect(n.calls()).toContainEqual(["preview", "--json", idA, "8080", "--wait"]);
		await n.until(() => shows() > before, "a refreshed detail");
		n.shown[0]!.done({ kind: "close" });
	});

	test("/nexus opens the picker, and Enter on a thread opens it", async () => {
		const n = load(scenario);
		const done = n.run("");
		await n.until(() => n.shown.length === 1 && n.text().includes(threads[1]!.title), "the picker");
		expect(n.shown[0]!.options).toBeUndefined();
		expect(n.calls()).toContainEqual(["threads", "--json", "--all"]);
		expect(n.calls()).toContainEqual(["projects", "--json"]);
		n.shown[0]!.component.handleInput!("\x1b[B");
		n.shown[0]!.component.handleInput!("\r");
		await n.until(() => n.shown.length === 2, "the thread view");
		expect(n.shown[1]!.options).toMatchObject({ overlay: true });
		n.shown[1]!.done({ kind: "close" });
		await done;
	});

	test("/nexus new opens the start form, starts the thread and opens it", async () => {
		const n = load(scenario);
		const done = n.run("new acme");
		await n.until(() => n.shown.length === 1 && n.text().includes("Start a thread"), "the start form");
		n.type("Fix it", 0);
		for (let i = 0; i < 3; i++) n.shown[0]!.component.handleInput!("\t");
		n.type("go");
		await n.until(() => n.shown.length === 2, "the started thread");
		expect(n.calls()).toContainEqual(["start", "--json", "--project=acme", "--message=go", "--title=Fix it"]);
		n.shown[1]!.done({ kind: "close" });
		await done;
	});

	test("Start again from a failed thread opens the form with its project and title", async () => {
		const n = load(scenario);
		const done = n.run(`open ${idA}`);
		await n.until(() => n.shown.length === 1 && n.text().includes("nexus / Fix"), "the thread view");
		n.type("/start-again");
		await n.until(() => n.shown.length === 2, "the start form");
		expect(n.text(1)).toContain("Fix the probe retry");
		n.shown[1]!.done(null);
		await done;
	});

	test("a reply without a field the console needs fails as a contract error", async () => {
		const { pylon: _, ...bare } = threads[1]!;
		const n = load({ ...scenario, responses: { ...scenario.responses, threads: [threads[0], bare] } });
		void n.run("");
		await n.until(() => n.shown.length === 1 && n.text().includes("could not be read"), "the picker's error");
		expect(n.text().replace(/\s+/g, " ")).toContain(
			`The threads could not be read: nexus threads' row for ${idB} has no pylon, which pi-nexus needs. Update the nexus CLI and the control plane`,
		);
		n.shown[0]!.done({ kind: "close" });

		const { attach: __, ...oldDetail } = detail;
		const o = load({ ...scenario, responses: { ...scenario.responses, show: oldDetail } });
		void o.run(`open ${idA}`);
		await o.until(() => o.shown.length === 1 && o.text().includes("could not be read"), "the detail's error");
		expect(o.text()).toContain(`The thread's details could not be read: nexus show ${idA} has no attach`);
		o.shown[0]!.done({ kind: "close" });
	});

	test("a live event without its fields ends the watch as a contract error, and a real call ID runs", async () => {
		// The output shows only if the call ID, `|` and all, matched the call's.
		const started = { type: "live", thread: idA, queued: [], tools: [{ callId: runningCall, output: "suite 3 of 9 passed" }], partial: null, retry: null };
		const n = load({ ...scenario, watch: [{ event: reset(idA, entries) }, { event: state(idA, working) }, { event: started as never }] });
		void n.run(`open ${idA}`);
		await n.until(() => n.shown.length === 1 && n.text().includes("suite 3 of 9 passed"), "the running call's output");
		n.shown[0]!.done({ kind: "close" });

		const broken = { type: "live", thread: idA, queued: [], partial: null, retry: null };
		const o = load({ ...scenario, watch: [{ event: reset(idA, entries) }, { event: state(idA, working) }, { event: broken as never }] });
		void o.run(`open ${idA}`);
		await o.until(() => o.shown.length === 1 && o.text().includes("The watch ended"), "the watch's error");
		expect(o.text()).toContain("The watch ended: a live event of nexus watch has no tools");
		o.shown[0]!.done({ kind: "close" });
	});

	test("a pi without custom UI gets the list and the transcript as notes", async () => {
		const n = load(scenario, { custom: false });
		await n.run("");
		expect(n.notes[0]!.title).toBe("threads");
		await n.run(`open ${idA}`);
		expect(n.notes[1]!.title).toStartWith(`${idA}`);
		await n.run("new");
		expect(n.notified.at(-1)![0]).toContain("the start form needs an interactive pi");
	});
});

describe("the contract", () => {
	const nexus = (s: Scenario) => {
		const fake = fakeNexus(s);
		cleanups.push(fake.cleanup);
		return createNexus(fake.bin);
	};
	const pylon = { node: "firebat", actualState: "running", failed: null };

	test("a thread row needs its pylon's node, state and failure, and only the failure may be null", async () => {
		const rows = (extra: object) => nexus({ responses: { threads: [{ ...threads[0], ...extra }] } });
		expect(await listThreads(rows({ pylon }))).toHaveLength(1);
		await expect(listThreads(rows({ pylon: { node: "firebat", failed: null } }))).rejects.toThrow(`nexus threads' row for ${idA} has no pylon.actualState`);
		await expect(listThreads(rows({ pylon: { node: "firebat", actualState: "running" } }))).rejects.toThrow("has no pylon.failed");
		await expect(listThreads(rows({ desired: null }))).rejects.toThrow(`nexus threads' row for ${idA} breaks the contract: desired is none of the values or shapes the contract allows`);
	});

	test("a detail needs its pylon's retry refusal, which may be null", async () => {
		const { retryRefused: _, ...bare } = detail.pylon;
		await expect(showThread(nexus({ responses: { show: { ...detail, pylon: bare } } }), idA)).rejects.toThrow(`nexus show ${idA} has no pylon.retryRefused`);
		expect(await showThread(nexus({ responses: { show: { ...detail, pylon: { ...detail.pylon, retryRefused: "the disk is gone" } } } }), idA)).toMatchObject({
			pylon: { retryRefused: "the disk is gone" },
		});
	});

	const watch = async (...events: object[]) => {
		const seen: unknown[] = [];
		await nexus({ watch: events.map((event) => ({ event: { thread: idA, ...event } as never })) }).watch(idA, (e) => seen.push(e), new AbortController().signal);
		return seen;
	};

	test("a detail needs its thread's conversation, which may be null, and every output's kind", async () => {
		const show = (reply: object) => showThread(nexus({ responses: { show: reply } }), idA);
		const { conversationId: _, ...noConversation } = detail.thread;
		await expect(show({ ...detail, thread: noConversation })).rejects.toThrow(`nexus show ${idA} has no thread.conversationId, which pi-nexus needs`);
		expect(await show({ ...detail, thread: { ...detail.thread, conversationId: null } })).toMatchObject({ thread: { conversationId: null } });
		await expect(show({ ...detail, outputs: [{ kind: null, ref: "web" }] })).rejects.toThrow(`nexus show ${idA} breaks the contract: outputs[0].kind must be string`);
	});

	test("a detail that breaks the contract shows as an error in the thread view, and its inspector still draws", async () => {
		const n = load({ ...scenario, responses: { ...scenario.responses, show: { ...detail, outputs: [{ kind: null, ref: "web" }] } } });
		void n.run(`open ${idA}`);
		await n.until(() => n.shown.length === 1 && n.text().includes("could not be read"), "the detail's error");
		expect(n.text().replace(/\s+/g, " ")).toContain(`The thread's details could not be read: nexus show ${idA} breaks the contract: outputs[0].kind must be string`);
		n.shown[0]!.component.handleInput!("\x1bi");
		expect(n.text()).toContain("Loading the pylon's details...");
		n.shown[0]!.done({ kind: "close" });
	});

	test("a state event is checked like the rest, while an unknown event type and extra fields pass", async () => {
		const good = { type: "state", ...working, since: "a field from a later CLI" };
		expect(await watch({ type: "progress", percent: 40 }, good)).toEqual([{ thread: idA, ...good }]);
		await expect(watch({ ...good, run: "busy" })).rejects.toThrow("a state event of nexus watch breaks the contract: run is none of the values or shapes the contract allows");
		const { queued: _, ...noQueued } = good;
		await expect(watch(noQueued)).rejects.toThrow("a state event of nexus watch has no queued");
		// A failure inside a message or a part names the field, read against the shape its role or type names.
		const badCall = { role: "assistant", model: "m", stopReason: "toolUse", content: [{ type: "toolCall", name: "bash", arguments: {} }] };
		await expect(watch({ type: "reset", entries: [{ entry: { id: 1, model: [badCall] }, text: "" }] })).rejects.toThrow(
			"a reset event of nexus watch has no entries[0].entry.model[0].content[0].id, which pi-nexus needs",
		);
		await expect(watch({ type: "reset", entries: [{ entry: { id: 1, model: [{ ...badCall, role: "critic" }] }, text: "" }] })).rejects.toThrow(
			"a reset event of nexus watch breaks the contract: entries[0].entry.model[0].role is none of the values the contract allows",
		);
	});

	test("a tool result needs its call ID and whether it failed", async () => {
		const result = { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "FAIL" }], isError: true };
		const reset = (message: object) => ({ type: "reset", entries: [{ entry: { id: 1, model: [message] }, text: "" }] });
		expect(await watch(reset(result))).toHaveLength(1);
		// Without its call ID the result would drop out and leave its call pending; without isError a failure would read as a success.
		const { toolCallId: _id, ...noCallId } = result;
		await expect(watch(reset(noCallId))).rejects.toThrow("a reset event of nexus watch has no entries[0].entry.model[0].toolCallId, which pi-nexus needs");
		const { isError: _error, ...noIsError } = result;
		await expect(watch(reset(noIsError))).rejects.toThrow("a reset event of nexus watch has no entries[0].entry.model[0].isError, which pi-nexus needs");
	});

	test("a handler that fails on an event ends the watch with that failure instead of escaping the stream", async () => {
		const watching = nexus({ watch: [{ event: { type: "state", thread: idA, ...working } }], watchHold: true }).watch(
			idA,
			() => {
				throw new Error("boom");
			},
			new AbortController().signal,
		);
		await expect(watching).rejects.toThrow("handling a state event of nexus watch failed: boom");
	});

	test("a live event needs its partial answer, its retry and each call's output, which may be empty", async () => {
		const whole = { type: "live", queued: [], tools: [{ callId: runningCall, output: "" }], partial: null, retry: null };
		expect(await watch(whole)).toHaveLength(1);
		const { partial: _, ...noPartial } = whole;
		await expect(watch(noPartial)).rejects.toThrow("a live event of nexus watch has no partial");
		const { retry: __, ...noRetry } = whole;
		await expect(watch(noRetry)).rejects.toThrow("has no retry");
		await expect(watch({ ...whole, tools: [{ callId: runningCall }] })).rejects.toThrow("has no tools[0].output");
	});
});
