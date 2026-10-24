import { afterEach, describe, expect, test } from "bun:test";
import { createNexus } from "../extensions/nexus/cli.ts";
import { nexusTools } from "../extensions/nexus/tools.ts";
import { assistant, entry, fakeNexus, head, idA, idB, idle, reset, row, state, thread, threads, toolCall, toolResult, user, working, type Scenario } from "./fixtures.ts";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function setup(scenario: Scenario) {
	const fake = fakeNexus(scenario);
	cleanups.push(fake.cleanup);
	const tools = Object.fromEntries(nexusTools(createNexus(fake.bin)).map((t) => [t.name, t]));
	const call = async (name: string, params: Record<string, unknown>, signal?: AbortSignal) => {
		const result = await tools[name]!.execute("call-1", params as never, signal, undefined, {} as never);
		return JSON.parse((result.content[0] as { text: string }).text);
	};
	return { call, calls: fake.calls, names: Object.keys(tools) };
}

async function failure(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (err) {
		return (err as Error).message;
	}
	throw new Error("expected the tool to fail");
}

describe("model tools", () => {
	test("the model gets no delete or retry", () => {
		expect(setup({}).names.sort()).toEqual(["nexus_archive", "nexus_preview", "nexus_read", "nexus_send", "nexus_start", "nexus_threads", "nexus_unpublish", "nexus_wait"]);
	});

	test("nexus_threads lists threads of a project", async () => {
		const now = Date.now();
		const { call, calls } = setup({ responses: { threads: [row(idA, { agentTurnRunning: true, createdAt: now - 3_600_000, lastAgentActivityAt: now - 125_000 })] } });
		expect(await call("nexus_threads", { project: "acme" })).toEqual([
			{ id: idA, project: "acme", title: `title of ${idA}`, status: "active", working: true, active: "2m ago" },
		]);
		expect(calls()).toEqual([["threads", "--json", "--project=acme"]]);
	});

	test("nexus_start passes the message and title through and returns the thread", async () => {
		const { call, calls } = setup({ responses: { start: thread(idA, { title: "Fix it" }) } });
		expect(await call("nexus_start", { project: "acme", message: "--fix the\nbug", title: "Fix it" })).toEqual({ id: idA, project: "acme", title: "Fix it" });
		expect(calls()).toEqual([["start", "--json", "--project=acme", "--message=--fix the\nbug", "--title=Fix it"]]);
	});

	test("nexus_send resolves a prefix and sends the text after --", async () => {
		const { call, calls } = setup({ responses: { threads, send: { submission: 3 } } });
		expect(await call("nexus_send", { thread: "ffff", text: "--steer is just text" })).toEqual({ thread: "th-ffff00001111", sent: true });
		expect(calls()).toEqual([
			["threads", "--json"],
			["send", "--json", "th-ffff00001111", "--", "--steer is just text"],
		]);
	});

	test("a whole thread ID needs no lookup", async () => {
		const { call, calls } = setup({ responses: { archive: thread(idA, { status: "archived" }) } });
		expect(await call("nexus_archive", { thread: idA })).toEqual({ thread: idA, status: "archived" });
		expect(calls()).toEqual([["archive", "--json", idA]]);
	});

	test("thread references fail as the mod's do", async () => {
		const { call } = setup({ responses: { threads } });
		expect(await failure(call("nexus_archive", { thread: "0123" }))).toBe(`nexus (failed): 0123 matches 2 threads: ${idA}, ${idB}.`);
		expect(await failure(call("nexus_archive", { thread: "abc" }))).toBe("nexus (failed): no thread starts with abc");
		expect(await failure(call("nexus_archive", { thread: "zz" }))).toBe("nexus (failed): zz is not a thread ID or a prefix of one.");
		expect(await failure(call("nexus_archive", { thread: " " }))).toBe("nexus (failed): thread is required");
	});

	test("nexus_read returns the state, its ports and the conversation from one watch poll", async () => {
		const why = "the service api failed. `nexus service logs api` in the pylon shows why";
		// A control plane older than a preview's `failed` leaves it out, which reads as null.
		const ports = [
			{ port: 5173, service: "web", preview: { service: "web", ready: true, failed: null, url: "https://firebat.example.ts.net:8443/" } },
			{ port: 8080, service: null, preview: { service: "port-8080", ready: false, url: "https://firebat.example.ts.net:8444/" } },
			{ port: 9000, service: null, preview: null },
			{ port: 9100, service: "api", preview: { service: "api", ready: false, failed: why, url: "https://firebat.example.ts.net:8445/" } },
		];
		const { call, calls } = setup({
			watch: [{ event: reset(idA, [head, user(1, "fix the bug"), assistant(2, "Fixed it.")]) }, { event: state(idA, { ...idle, ports }) }],
			watchHold: true,
		});
		expect(await call("nexus_read", { thread: idA })).toEqual({
			thread: idA,
			status: "active",
			run: "idle",
			pylon: "running",
			queued: 0,
			ports: [
				{ port: 5173, service: "web", url: "https://firebat.example.ts.net:8443/", ready: true },
				{ port: 8080, url: "https://firebat.example.ts.net:8444/", ready: false },
				{ port: 9000 },
				{ port: 9100, service: "api", url: "https://firebat.example.ts.net:8445/", ready: false, failed: why },
			],
			conversation: "> fix the bug\n\nFixed it.",
		});
		expect(calls()[0]).toEqual(["watch", idA, "--json"]);
	});

	test("nexus_read says when the ports are unknown", async () => {
		const { call } = setup({ watch: [{ event: reset(idA, []) }, { event: state(idA, { ...idle, ports: null }) }], watchHold: true });
		expect(await call("nexus_read", { thread: idA })).toMatchObject({ ports: null });
	});

	test("nexus_preview publishes the port, waits for it and returns its URL", async () => {
		const { call, calls } = setup({ responses: { preview: { pylon: "py-1", service: "port-8080", httpsPort: 8444, ready: true, url: "https://firebat.example.ts.net:8444/" } } });
		expect(await call("nexus_preview", { thread: idA, port: 8080 })).toEqual({ thread: idA, port: 8080, url: "https://firebat.example.ts.net:8444/", ready: true });
		expect(calls()).toEqual([["preview", "--json", idA, "8080", "--wait"]]);
	});

	test("nexus_preview fails with the CLI's refusal, and on a preview without its URL", async () => {
		const refused = setup({ fail: { preview: { exit: 5, kind: "conflict", error: "the pylon is not running" } } });
		expect(await failure(refused.call("nexus_preview", { thread: idA, port: 8080 }))).toBe("nexus (conflict): the pylon is not running");
		const old = setup({ responses: { preview: { pylon: "py-1", service: "port-8080", httpsPort: 8444, ready: true } } });
		expect(await failure(old.call("nexus_preview", { thread: idA, port: 8080 }))).toStartWith("nexus (contract): nexus preview has no url, which pi-nexus needs.");
	});

	test("nexus_preview says whether a cancel came before the port was published", async () => {
		const before = setup({ responses: { threads } });
		const stop = new AbortController();
		stop.abort();
		expect(await failure(before.call("nexus_preview", { thread: idA, port: 8080 }, stop.signal))).toBe("nexus: cancelled before the port was published");
		expect(before.calls()).toEqual([]);
		const during = setup({ responses: { preview: null }, delayMs: { preview: 5_000 } });
		const waiting = new AbortController();
		setTimeout(() => waiting.abort(), 300);
		expect(await failure(during.call("nexus_preview", { thread: idA, port: 8080 }, waiting.signal))).toBe(
			"nexus: cancelled while waiting for the preview; the port may be published already",
		);
	});

	test("nexus_unpublish unpublishes the port's preview", async () => {
		const { call, calls } = setup({ responses: { unpreview: null } });
		expect(await call("nexus_unpublish", { thread: idA, port: 8080 })).toEqual({ thread: idA, port: 8080, unpublished: true });
		expect(calls()).toEqual([["unpreview", "--json", idA, "8080"]]);
	});

	test("nexus_unpublish fails with the CLI's refusal, on a reply other than null, and on a CLI without unpreview", async () => {
		const refused = setup({ fail: { unpreview: { exit: 1, kind: "failed", error: "port 5173 is previewed by the service web, which keeps its preview" } } });
		expect(await failure(refused.call("nexus_unpublish", { thread: idA, port: 5173 }))).toBe("nexus (failed): port 5173 is previewed by the service web, which keeps its preview");
		const odd = setup({ responses: { unpreview: { ok: true } } });
		expect(await failure(odd.call("nexus_unpublish", { thread: idA, port: 8080 }))).toStartWith("nexus (contract): nexus unpreview breaks the contract");
		// What CLI 0.2.0 prints for a command it does not have.
		const old = setup({ fail: { unpreview: { exit: 64, kind: "invalid", error: "unknown command unpreview" } } });
		expect(await failure(old.call("nexus_unpublish", { thread: idA, port: 8080 }))).toBe(
			"nexus (invalid): nexus has no unpreview command: unpublishing a preview needs Nexus CLI 0.3.0 or later (nexus --version)",
		);
	});

	test("nexus_unpublish says whether a cancel came before the preview was closed", async () => {
		const before = setup({ responses: { threads } });
		const stop = new AbortController();
		stop.abort();
		expect(await failure(before.call("nexus_unpublish", { thread: idA, port: 8080 }, stop.signal))).toBe("nexus: cancelled before the preview was closed");
		expect(before.calls()).toEqual([]);
		const during = setup({ responses: { unpreview: null }, delayMs: { unpreview: 5_000 } });
		const waiting = new AbortController();
		setTimeout(() => waiting.abort(), 300);
		expect(await failure(during.call("nexus_unpublish", { thread: idA, port: 8080 }, waiting.signal))).toBe(
			"nexus: cancelled while closing the preview; it may be closed already",
		);
	});

	test("nexus_read keeps the last 6000 characters", async () => {
		const { call } = setup({
			watch: [{ event: reset(idA, [user(1, "a".repeat(7000)), assistant(2, "the end")]) }, { event: state(idA, idle) }],
			watchHold: true,
		});
		const { conversation } = await call("nexus_read", { thread: idA });
		expect(conversation).toStartWith("[1011 earlier characters left out]\n");
		expect(conversation).toEndWith("the end");
	});

	test("nexus_wait returns the reply once a state says the run settled", async () => {
		const { call } = setup({
			watch: [
				{ event: reset(idA, [user(1, "fix the bug")]) },
				{ event: state(idA, working) },
				{ event: entry(idA, toolCall(2)), delayMs: 50 },
				{ event: entry(idA, assistant(3, "Fixed it.")), delayMs: 50 },
				{ event: state(idA, idle) },
			],
			watchHold: true,
		});
		const started = Date.now();
		expect(await call("nexus_wait", { thread: idA, timeout_seconds: 10 })).toEqual({
			thread: idA,
			settled: true,
			status: "active",
			run: "idle",
			pylon: "running",
			queued: 0,
			ports: [],
			reply: "Fixed it.",
		});
		expect(Date.now() - started).toBeLessThan(1000);
	});

	test("nexus_wait does not take a booting thread's idle run for a reply", async () => {
		const { call } = setup({
			watch: [
				{ event: reset(idA, []) },
				{ event: state(idA, { ...idle, pylon: "booting" }) },
				{ event: entry(idA, user(1, "hi")), delayMs: 300 },
				{ event: state(idA, working) },
				{ event: entry(idA, assistant(2, "Hello.")), delayMs: 300 },
				{ event: state(idA, idle) },
			],
			watchHold: true,
		});
		const waited = await call("nexus_wait", { thread: idA, timeout_seconds: 10 });
		expect(waited.settled).toBe(true);
		expect(waited.reply).toBe("Hello.");
	});

	test("nexus_wait judges a poll's entries by that poll's state", async () => {
		const { call } = setup({
			watch: [
				{ event: reset(idA, []) },
				{ event: state(idA, { ...idle, pylon: "booting" }) },
				{ event: entry(idA, user(1, "one")), delayMs: 300 },
				{ event: entry(idA, assistant(2, "two")) },
				{ event: entry(idA, user(3, "three")) },
				{ event: state(idA, working) },
				{ event: entry(idA, assistant(4, "four")), delayMs: 300 },
				{ event: state(idA, idle) },
			],
			watchHold: true,
		});
		expect((await call("nexus_wait", { thread: idA, timeout_seconds: 10 })).reply).toBe("four");
	});

	test("nexus_wait counts an answer with no state change after a quiet second", async () => {
		const { call } = setup({
			watch: [{ event: reset(idA, [user(1, "hi")]) }, { event: state(idA, idle) }, { event: entry(idA, toolCall(2)), delayMs: 300 }, { event: entry(idA, toolResult(3)) }],
			watchHold: true,
		});
		const started = Date.now();
		const waited = await call("nexus_wait", { thread: idA, timeout_seconds: 10 });
		expect(waited.settled).toBe(true);
		expect(waited.reply).toBeNull();
		expect(Date.now() - started).toBeGreaterThanOrEqual(1300);
	});

	test("nexus_wait settles on parked tasks", async () => {
		const { call } = setup({
			watch: [{ event: reset(idA, [user(1, "hi")]) }, { event: state(idA, { ...working, run: "parked", parkedTasks: 2 }) }],
			watchHold: true,
		});
		const waited = await call("nexus_wait", { thread: idA });
		expect(waited).toMatchObject({ settled: true, run: "parked", reply: null, needs_human: expect.stringContaining("/nexus retry") });
	});

	test("nexus_wait settles at once on a failed pylon, even while the run is working", async () => {
		const { call } = setup({ watch: [{ event: reset(idA, [user(1, "hi")]) }, { event: state(idA, { ...working, failed: "boot timed out" }) }], watchHold: true });
		const started = Date.now();
		expect(await call("nexus_wait", { thread: idA, timeout_seconds: 10 })).toMatchObject({
			settled: true,
			run: "working",
			failed: "boot timed out",
			needs_human: expect.stringContaining("/nexus retry-pylon"),
			reply: null,
		});
		expect(Date.now() - started).toBeLessThan(1000);
	});

	test("nexus_wait settles a run that worked and went idle without writing anything", async () => {
		const { call } = setup({
			watch: [{ event: reset(idA, [user(1, "hi")]) }, { event: state(idA, working) }, { event: state(idA, idle), delayMs: 300 }],
			watchHold: true,
		});
		expect(await call("nexus_wait", { thread: idA, timeout_seconds: 10 })).toMatchObject({ settled: true, run: "idle", reply: null });
	});

	test("nexus_wait gives no reply for an aborted latest turn, not the earlier answer", async () => {
		const { call } = setup({
			watch: [
				{ event: reset(idA, [user(1, "first"), assistant(2, "old answer"), user(3, "second")]) },
				{ event: state(idA, working) },
				{ event: entry(idA, assistant(4, "", "aborted")), delayMs: 300 },
				{ event: state(idA, idle) },
			],
			watchHold: true,
		});
		expect(await call("nexus_wait", { thread: idA, timeout_seconds: 10 })).toMatchObject({ settled: true, reply: null });
	});

	test("nexus_wait joins a reply written in parts", async () => {
		const { call } = setup({
			watch: [
				{ event: reset(idA, [user(1, "go"), assistant(2, "Build passed."), toolCall(3), toolResult(4), assistant(5, "Tests passed.")]) },
				{ event: state(idA, idle) },
			],
			watchHold: true,
		});
		expect((await call("nexus_wait", { thread: idA })).reply).toBe("Build passed.\n\nTests passed.");
	});

	test("nexus_wait gives up at its timeout and reports an outage", async () => {
		const { call } = setup({
			watch: [{ event: reset(idA, [user(1, "hi")]) }, { event: state(idA, working) }, { event: { type: "error", thread: idA, kind: "unreachable", message: "proxy down" } }],
			watchHold: true,
		});
		expect(await call("nexus_wait", { thread: idA, timeout_seconds: 1 })).toEqual({
			thread: idA,
			settled: false,
			timed_out: true,
			status: "active",
			run: "working",
			pylon: "running",
			queued: 0,
			ports: [],
			outage: "Nexus is unreachable: proxy down.",
			reply: null,
		});
	});

	test("nexus_wait reports a cancel", async () => {
		const { call } = setup({ watch: [{ event: reset(idA, [user(1, "hi")]) }, { event: state(idA, working) }], watchHold: true });
		const stop = new AbortController();
		setTimeout(() => stop.abort(), 300);
		expect(await call("nexus_wait", { thread: idA }, stop.signal)).toMatchObject({ settled: false, cancelled: true });
	});

	test("a down proxy fails the call with the CLI's message", async () => {
		const hint = "nothing listens on the SOCKS proxy localhost:1055. Is ts-home up? Check ts-home status";
		const { call } = setup({ fail: { threads: { exit: 2, kind: "unreachable", error: hint } } });
		expect(await failure(call("nexus_threads", {}))).toBe(`nexus (unreachable): ${hint}`);
	});

	test("a control plane that is down before the first poll fails a read", async () => {
		const { call } = setup({
			watch: [{ event: { type: "error", thread: idA, kind: "unreachable", message: "cannot reach the proxy" } }],
			watchHold: true,
		});
		expect(await failure(call("nexus_read", { thread: idA }))).toBe("nexus (unreachable): cannot reach the proxy");
	});

	test("a failing control plane before the first poll fails a read as failed, not unreachable", async () => {
		const { call } = setup({
			watch: [{ event: { type: "error", thread: idA, kind: "failed", message: "the API answered 502" } }],
			watchHold: true,
		});
		expect(await failure(call("nexus_read", { thread: idA }))).toBe("nexus (failed): the API answered 502");
	});

	test("an unknown thread fails with not-found", async () => {
		const { call } = setup({ fail: { watch: { exit: 4, kind: "not-found", error: `no thread ${idA}` } } });
		expect(await failure(call("nexus_read", { thread: idA }))).toBe(`nexus (not-found): no thread ${idA}`);
	});

	test("stderr that is not the CLI's JSON falls back to the exit code", async () => {
		const { call } = setup({ fail: { archive: { exit: 5, stderr: "something else\n" } } });
		expect(await failure(call("nexus_archive", { thread: idA }))).toBe("nexus (conflict): something else");
	});

	test("a missing binary says how to point at one", async () => {
		const tools = nexusTools(createNexus("/nonexistent/nexus"));
		const threadsTool = tools.find((t) => t.name === "nexus_threads")!;
		expect(await failure(threadsTool.execute("call-1", {}, undefined, undefined, {} as never))).toContain("NEXUS_BIN");
	});
});
