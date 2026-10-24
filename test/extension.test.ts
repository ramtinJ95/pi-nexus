import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import nexusExtension from "../extensions/nexus/index.ts";
import { createNexus } from "../extensions/nexus/cli.ts";
import { memoryStores } from "./console-fixture.ts";
import { assistant, entry, fakeNexus, idA, idle, reset, state, thread, threads, user, working, type Scenario } from "./fixtures.ts";

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
	test("registers the eight model tools and no delete or pylon retry", () => {
		expect(load({}).tools.sort()).toEqual(["nexus_archive", "nexus_preview", "nexus_read", "nexus_send", "nexus_start", "nexus_threads", "nexus_unpublish", "nexus_wait"]);
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
