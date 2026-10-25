import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import nexusExtension from "../extensions/nexus/index.ts";
import { createNexus, isOlder, parseVersion, type Nexus } from "../extensions/nexus/cli.ts";
import { detail, memoryStores } from "./console-fixture.ts";
import { assistant, entry, fakeNexus, idA, idB, idle, reset, state, thread, threads, user, working, type Scenario } from "./fixtures.ts";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

/** `answer` is what the person picks in a dialog, undefined for dismissing it. */
function load(scenario: Scenario, { answer }: { answer?: string } = { answer: "Delete" }) {
	const fake = fakeNexus(scenario);
	const notes: { title: string; body: string; error?: boolean }[] = [];
	const notified: [string, string | undefined][] = [];
	const asked: { title: string; options: string[] }[] = [];
	const status = new Map<string, string | undefined>();
	const widgets = new Map<string, string[] | undefined>();
	const handlers = new Map<string, () => void>();
	let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	const tools: { name: string; execute: (...args: unknown[]) => Promise<unknown> }[] = [];
	const pi = {
		registerEntryRenderer() {},
		registerTool: (tool: (typeof tools)[number]) => tools.push(tool),
		registerCommand: (_name: string, options: { handler: typeof command }) => (command = options.handler),
		on: (event: string, handler: () => void) => handlers.set(event, handler),
		appendEntry: (_type: string, note: (typeof notes)[number]) => notes.push(note),
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: true,
		ui: {
			notify: (message: string, type?: string) => notified.push([message, type]),
			select: async (title: string, options: string[]) => {
				asked.push({ title, options });
				return answer;
			},
			setStatus: (key: string, text: string | undefined) => status.set(key, text),
			setWidget: (key: string, lines: string[] | undefined) => widgets.set(key, lines),
		},
	} as unknown as ExtensionCommandContext;
	nexusExtension(pi, createNexus(fake.bin), undefined, memoryStores());
	cleanups.push(() => handlers.get("session_shutdown")?.(), fake.cleanup);
	const shutdown = () => handlers.get("session_shutdown")!();
	const tool = (name: string, params: object) => tools.find((t) => t.name === name)!.execute("call-1", params, undefined, undefined, ctx);
	return { run: (args: string) => command!(args, ctx), tool, shutdown, calls: fake.calls, notes, notified, asked, status, widgets, tools: tools.map((t) => t.name) };
}

const until = async (check: () => boolean) => {
	for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
	expect(check()).toBe(true);
};

describe("/nexus", () => {
	test("registers the ten model tools and no delete or pylon retry", () => {
		expect(load({}).tools.sort()).toEqual(["nexus_archive", "nexus_preview", "nexus_project_add", "nexus_projects", "nexus_read", "nexus_send", "nexus_start", "nexus_threads", "nexus_unpublish", "nexus_wait"]);
	});

	test("unpublish runs nexus unpreview and says so, and an older CLI says to update", async () => {
		const n = load({ responses: { threads, unpreview: null } });
		await n.run("unpublish 0123456789ab 8080");
		expect(n.calls()).toContainEqual(["unpreview", "--json", idA, "8080"]);
		expect(n.notified).toContainEqual([`Unpublished port 8080 of ${idA}. Publishing it again may give it a new URL.`, "info"]);
		const old = load({ responses: { threads }, fail: { unpreview: { exit: 64, kind: "invalid", error: "unknown command unpreview" } } });
		await old.run(`unpublish ${idA} 8080`);
		expect(old.notified).toContainEqual(["nexus: nexus has no unpreview command: unpublishing a preview needs Nexus CLI 0.3.0 or later (nexus --version)", "error"]);
	});

	test("session open runs nexus session open with its flags, says so, and an older CLI says to update", async () => {
		const opened = { herdrPane: "%7", harness: "pi", title: "log in" };
		const n = load({ responses: { threads, "session open": opened } });
		await n.run('session open 0123456789ab --harness pi --title "log in"');
		expect(n.calls()).toContainEqual(["session", "open", "--json", "--harness=pi", "--title=log in", "--", idA]);
		expect(n.notified).toEqual([
			[`Opening pi "log in" in ${idA}. Its agent can take a minute to start.`, "info"],
			[`Opened pi "log in" in pane %7 of ${idA}. /nexus session attach ${idA} attaches to it.`, "info"],
		]);
		const old = load({ responses: { threads }, fail: { "session open": { exit: 64, kind: "invalid", error: "unknown command session" } } });
		await old.run(`session open ${idA}`);
		expect(old.calls()).toContainEqual(["session", "open", "--json", "--", idA]);
		expect(old.notified.at(-1)).toEqual(["nexus: nexus has no session open command: opening a session needs Nexus CLI 0.5.0 or later (nexus --version)", "error"]);
	});

	test("session close closes the session given by its pane or ID, or asks which with Keep them all first", async () => {
		const n = load({ responses: { threads, "session close": null } });
		await n.run(`session close ${idA} %3`);
		expect(n.calls()).toContainEqual(["session", "close", "--json", "--", idA, "%3"]);
		expect(n.notified).toEqual([[`Closed session %3 of ${idA}.`, "info"]]);
		// A control plane older than session states lists sessions without state, ID or message, which read as running in their pane.
		const sessions = [{ ...detail.sessions[0]!, title: "review" }, { harness: "claude-code", herdrPane: "%5", status: "idle", harnessSessionId: null }];
		const asking = load({ responses: { threads, show: { ...detail, sessions }, "session close": null } }, { answer: "Claude Code in pane %5, idle" });
		await asking.run(`session close ${idA}`);
		expect(asking.asked).toEqual([{ title: `Close which session of ${idA}? A running one's agent ends.`, options: ["Keep them all", 'pi "review" in pane %3, working', "Claude Code in pane %5, idle"] }]);
		expect(asking.calls()).toContainEqual(["session", "close", "--json", "--", idA, "%5"]);
		const kept = load({ responses: { threads, show: { ...detail, sessions } } }, { answer: undefined });
		await kept.run(`session close ${idA}`);
		expect(kept.calls().some((c) => c[0] === "session")).toBe(false);
		expect(kept.notified).toEqual([[`Kept the sessions of ${idA}.`, "info"]]);
		const none = load({ responses: { threads, show: { ...detail, sessions: [] } } });
		await none.run(`session close ${idA}`);
		expect(none.notified).toEqual([[`${idA} has no sessions.`, "info"]]);
		const old = load({ responses: { threads }, fail: { "session close": { exit: 64, kind: "invalid", error: "unknown command session" } } });
		await old.run(`session close ${idA} %3`);
		expect(old.notified.at(-1)).toEqual(["nexus: nexus has no session close command: closing a session needs Nexus CLI 0.5.0 or later (nexus --version)", "error"]);
	});

	test("session close never offers a paused session, offers a failed one with why, and closes it by its ID", async () => {
		const paused = { ...detail.sessions[0]!, id: "w1:p1", herdrPane: "w1:p1", state: "paused", title: "review" };
		const failed = { ...detail.sessions[0]!, id: "failed-0123456789ab", herdrPane: null, harnessSessionId: "/s.jsonl", state: "failed", title: "plan", message: "herdr agent start: the agent did not start.\nThe pane showed:\n$" };
		const label = 'pi "plan" in session failed-0123456789ab, failed: herdr agent start: the agent did not start.';
		const asking = load({ responses: { threads, show: { ...detail, sessions: [paused, failed] }, "session close": null } }, { answer: label });
		await asking.run(`session close ${idA}`);
		expect(asking.asked).toEqual([{ title: `Close which session of ${idA}? A running one's agent ends.`, options: ["Keep them all", label] }]);
		expect(asking.calls()).toContainEqual(["session", "close", "--json", "--", idA, "failed-0123456789ab"]);
		expect(asking.notified).toEqual([[`Closed session failed-0123456789ab of ${idA}.`, "info"]]);
		// With only paused sessions there is nothing to ask, and nothing is sent.
		const archived = { ...detail, thread: { ...detail.thread, status: "archived" }, sessions: [paused] };
		const onlyPaused = load({ responses: { threads, show: archived } });
		await onlyPaused.run(`session close ${idA}`);
		expect(onlyPaused.calls().some((c) => c[0] === "session")).toBe(false);
		expect(onlyPaused.notified).toEqual([[`${idA} has no session to close: pi "review" is paused with the pylon and resumes on unarchive. Close it once it runs.`, "info"]]);
	});

	test("session close shows the CLI's refusal of a paused session, and of a pane a wake moved, in its words", async () => {
		const refusal = `session w1:p1 is paused with its pylon and resumes when its pylon wakes. Close it once it runs`;
		const n = load({ responses: { threads }, fail: { "session close": { exit: 5, kind: "conflict", error: refusal } } });
		await n.run(`session close ${idA} w1:p1`);
		expect(n.calls().filter((c) => c[0] === "session")).toHaveLength(1);
		expect(n.notified.at(-1)).toEqual([`nexus: ${refusal}`, "error"]);
		const moved = "no session is open in pane w1:p1 of pylon py-0123. A wake may have moved it to another pane, which the thread's sessions list";
		const gone = load({ responses: { threads }, fail: { "session close": { exit: 4, kind: "not-found", error: moved } } });
		await gone.run(`session close ${idA} w1:p1`);
		expect(gone.notified.at(-1)).toEqual([`nexus: ${moved}`, "error"]);
	});

	test("session close needs CLI 0.8.0, refused before it runs on an older one, and a new enough version is read once", async () => {
		const old = load({ responses: { threads, "session close": null }, version: "0.7.0" });
		await old.run(`session close ${idA} w1:p1`);
		expect(old.calls().some((c) => c[0] === "session")).toBe(false);
		expect(old.notified.at(-1)![0]).toEndWith(" is 0.7.0: closing a session needs Nexus CLI 0.8.0 or later (nexus --version)");
		// Each refusal reads the version again, so a CLI updated meanwhile is not refused from memory.
		await old.run(`session close ${idA} w1:p1`);
		expect(old.calls().filter((c) => c[0] === "--version")).toHaveLength(2);
		const unreadable = load({ responses: { threads }, version: "dev" });
		await unreadable.run(`session close ${idA} w1:p1`);
		expect(unreadable.calls().some((c) => c[0] === "session")).toBe(false);
		expect(unreadable.notified.at(-1)![0]).toContain('--version printed no version ("nexus dev"): closing a session needs Nexus CLI 0.8.0 or later');
		const current = load({ responses: { threads, "session close": null }, version: "0.8.0" });
		await current.run(`session close ${idA} %3`);
		await current.run(`session close ${idA} %4`);
		expect(current.calls().filter((c) => c[0] === "--version")).toHaveLength(1);
		expect(current.calls().filter((c) => c[0] === "session")).toHaveLength(2);
	});

	test("nexus --version reads as numbers, and an older version compares before a newer one", () => {
		expect(parseVersion("nexus 0.8.0\n")).toEqual([0, 8, 0]);
		expect(parseVersion("nexus 0.10.2")).toEqual([0, 10, 2]);
		expect(parseVersion("usage: nexus")).toBeNull();
		expect(isOlder([0, 7, 9], [0, 8, 0])).toBe(true);
		expect(isOlder([0, 10, 0], [0, 8, 0])).toBe(false);
		expect(isOlder([0, 8, 0], [0, 8, 0])).toBe(false);
		expect(isOlder([1, 0, 0], [0, 8, 0])).toBe(false);
	});

	test("a port being published or unpublished refuses a second change from any entry point, without queueing it", async () => {
		const preview = { pylon: "py-1", service: "port-8080", httpsPort: 8444, ready: true, url: "https://firebat.example.ts.net:8444/" };
		const n = load({ responses: { threads, preview, unpreview: null }, delayMs: { preview: 600 } });
		const busy = `Port 8080 on ${idA} is already being published or unpublished. Try again when it finishes.`;
		const publishing = n.tool("nexus_preview", { thread: idA, port: 8080 });
		await until(() => n.calls().some((c) => c[0] === "preview"));
		// The model's publish holds the port against the /nexus command and the model's own unpublish.
		await n.run(`unpublish ${idA} 8080`);
		expect(n.notified).toContainEqual([`nexus: ${busy}`, "error"]);
		await expect(n.tool("nexus_unpublish", { thread: idA, port: 8080 })).rejects.toThrow(`nexus (conflict): ${busy}`);
		expect(n.calls().filter((c) => c[0] === "unpreview")).toEqual([]);
		// Another port, or the same port on another thread, is free.
		await n.run(`unpublish ${idA} 9000`);
		await n.run(`unpublish ${idB} 8080`);
		expect(n.calls().filter((c) => c[0] === "unpreview")).toEqual([
			["unpreview", "--json", idA, "9000"],
			["unpreview", "--json", idB, "8080"],
		]);
		await publishing;
		// Once the publish ends, the refused unpublish can run; nothing ran it in the meantime.
		await n.run(`unpublish ${idA} 8080`);
		expect(n.calls().filter((c) => c[0] === "unpreview" && c[2] === idA && c[3] === "8080")).toHaveLength(1);
	});

	test("list shows the threads and sets the working count", async () => {
		const n = load({ responses: { threads } });
		await n.run("list");
		expect(n.notes[0]!.title).toBe("threads");
		expect(n.notes[0]!.body).toContain(idA);
		await until(() => n.status.get("nexus") === "nexus 1 working");
	});

	test("delete offers Keep first, and keeping or dismissing keeps the thread", async () => {
		for (const answer of ["Keep", undefined]) {
			const n = load({ responses: { threads } }, { answer });
			await n.run("delete 0123456789ab");
			expect(n.asked).toEqual([{ title: `Delete ${idA}? Its pylon is deleted for good.`, options: ["Keep", "Delete"] }]);
			expect(n.calls().some((c) => c[0] === "delete")).toBe(false);
			expect(n.notified).toContainEqual([`Kept ${idA}.`, "info"]);
		}
	});

	test("delete runs once Delete is picked", async () => {
		const n = load({ responses: { threads, delete: thread(idA, { status: "deleted" }) } });
		await n.run(`delete ${idA}`);
		expect(n.calls()).toContainEqual(["delete", "--json", idA]);
		expect(n.notified).toContainEqual([`Deleted ${idA}.`, "info"]);
	});

	test("a down proxy is shown as an error and in the status line", async () => {
		const error = "nothing listens on the SOCKS proxy localhost:1055. Check ts-home status";
		const n = load({ fail: { threads: { exit: 2, kind: "unreachable", error } } });
		await n.run("list");
		expect(n.notified).toEqual([[`nexus: ${error}`, "error"]]);
		await until(() => n.status.get("nexus") === "nexus unreachable");
	});

	test("send follows the thread through its reply", async () => {
		const n = load({
			responses: { threads, send: { submission: 1 } },
			watch: [
				{ event: reset(idA, [user(1, "hi")]) },
				{ event: state(idA, working) },
				{ event: entry(idA, assistant(2, "Hello.")), delayMs: 50 },
				{ event: state(idA, idle) },
			],
			watchHold: true,
		});
		await n.run(`send ${idA} hi`);
		expect(n.calls()[0]).toEqual(["send", "--json", idA, "--", "hi"]);
		await until(() => n.notified.some(([m]) => m === `Stopped following ${idA}: the agent answered`));
		expect(n.notes.map((note) => note.body)).toEqual(["> hi", "Hello."]);
		expect(n.widgets.get("nexus")).toBeUndefined();
	});

	test("a shutdown ends every watch and starts no more CLI runs", async () => {
		const n = load({ responses: { threads }, watch: [{ event: reset(idA, []) }, { event: state(idA, idle) }], watchHold: true });
		await n.run(`follow ${idA}`);
		await until(() => n.calls().some((c) => c[0] === "watch"));
		n.shutdown();
		await until(() => n.calls().some((c) => c[0] === "<watch ended>"));
		const count = n.calls().length;
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(n.calls()).toHaveLength(count);
		expect(n.status.get("nexus")).toBeUndefined();
		expect(n.widgets.get("nexus")).toBeUndefined();
	});

	test("a shutdown ends a model's wait", async () => {
		const n = load({ watch: [{ event: reset(idA, [user(1, "hi")]) }, { event: state(idA, working) }], watchHold: true });
		const wait = n.tool("nexus_wait", { thread: idA });
		await until(() => n.calls().some((c) => c[0] === "watch"));
		n.shutdown();
		const result = (await wait) as { content: { text: string }[] };
		expect(JSON.parse(result.content[0]!.text)).toMatchObject({ settled: false, cancelled: true });
		await until(() => n.calls().some((c) => c[0] === "<watch ended>"));
	});

	test("a follow restarted while the old watch is still exiting keeps running", async () => {
		const n = load({ watch: [{ event: reset(idA, []) }, { event: state(idA, idle) }], watchHold: true, watchExitDelayMs: 500 });
		await n.run(`follow ${idA}`);
		await until(() => n.calls().filter((c) => c[0] === "watch").length === 1);
		await n.run(`unfollow ${idA}`);
		await n.run(`follow ${idA}`);
		await until(() => n.calls().filter((c) => c[0] === "watch").length === 2);
		await until(() => n.calls().some((c) => c[0] === "<watch ended>"));
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(n.widgets.get("nexus")).toEqual([`following ${idA}: active, agent idle, pylon running`]);
		await n.run(`unfollow ${idA}`);
		expect(n.notified.some(([m]) => m === "Not following that.")).toBe(false);
	});

	test("the follow widget shows an outage until the next state", async () => {
		const n = load({
			watch: [
				{ event: { type: "error", thread: idA, kind: "unreachable", message: "nothing listens on the SOCKS proxy localhost:1" } },
				{ event: reset(idA, []), delayMs: 300 },
				{ event: state(idA, idle) },
			],
			watchHold: true,
		});
		await n.run(`follow ${idA}`);
		await until(() => n.widgets.get("nexus")?.[0] === `following ${idA}: Nexus is unreachable: nothing listens on the SOCKS proxy localhost:1.`);
		await until(() => n.widgets.get("nexus")?.[0] === `following ${idA}: active, agent idle, pylon running`);
	});

	test("unfollow by prefix works while Nexus is down", async () => {
		const n = load({
			fail: { threads: { exit: 2, kind: "unreachable", error: "nothing listens on the SOCKS proxy" } },
			watch: [{ event: reset(idA, []) }, { event: state(idA, idle) }],
			watchHold: true,
		});
		await n.run(`follow ${idA}`);
		await until(() => n.calls().some((c) => c[0] === "watch"));
		await n.run("unfollow 0123");
		await until(() => n.calls().some((c) => c[0] === "<watch ended>"));
		expect(n.notified.filter(([, type]) => type === "error")).toEqual([]);
		expect(n.widgets.get("nexus")).toBeUndefined();
	});

	test("unfollow of a thread not followed says so", async () => {
		const n = load({ watch: [{ event: reset(idA, []) }, { event: state(idA, idle) }], watchHold: true });
		await n.run(`follow ${idA}`);
		await n.run("unfollow ffff");
		expect(n.notified).toContainEqual(["Not following that.", "info"]);
		expect(n.widgets.get("nexus")).toEqual([expect.stringContaining(`following ${idA}`)]);
	});

	test("usage mistakes are shown", async () => {
		const n = load({});
		await n.run("send");
		expect(n.notified[0]![0]).toStartWith("nexus: send needs a thread");
		expect(n.calls().some((c) => c[0] === "send")).toBe(false);
	});
});

describe("the status poll", () => {
	/** A Nexus whose `threads` answers only when the test says, recording each run's signal. */
	function held() {
		const runs: { args: readonly string[]; signal: AbortSignal | undefined; answer: () => void }[] = [];
		const nexus: Nexus = {
			bin: "nexus",
			run: (args, signal) =>
				new Promise((resolve, reject) => {
					runs.push({ args, signal, answer: () => resolve(args[0] === "threads" ? threads : null) });
					signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
			watch: async () => {},
			attach: async () => {},
			version: async () => "nexus 0.8.0\n",
		};
		const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
		let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
		const pi = {
			registerEntryRenderer() {},
			registerTool() {},
			registerCommand: (_name: string, options: { handler: typeof command }) => (command = options.handler),
			on: (event: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(event, handler),
			appendEntry() {},
		} as unknown as ExtensionAPI;
		const ctx = { hasUI: true, ui: { notify() {}, setStatus() {}, setWidget() {} } } as unknown as ExtensionCommandContext;
		nexusExtension(pi, nexus, undefined, memoryStores());
		cleanups.push(() => handlers.get("session_shutdown")?.(undefined, undefined));
		return {
			runs,
			start: () => handlers.get("session_start")!({ type: "session_start" }, ctx),
			shutdown: () => handlers.get("session_shutdown")!(undefined, undefined),
			run: (args: string) => command!(args, ctx),
		};
	}
	const threadsRuns = (runs: { args: readonly string[] }[]) => runs.filter((r) => r.args[0] === "threads");

	test("/nexus strip off aborts the poll in flight and starts none", async () => {
		const n = held();
		n.start();
		expect(threadsRuns(n.runs)).toHaveLength(1);
		await n.run("strip off");
		expect(threadsRuns(n.runs)).toHaveLength(1);
		expect(n.runs[0]!.signal?.aborted).toBe(true);
	});

	test("the session's end aborts the poll in flight", () => {
		const n = held();
		n.start();
		n.shutdown();
		expect(n.runs[0]!.signal?.aborted).toBe(true);
	});
});
