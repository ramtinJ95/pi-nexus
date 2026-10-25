/** The extension inside a real pi, driven over pi's RPC mode, against the fake nexus binary. */
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { assistant, entry, fakeNexus, idA, idle, reset, state, thread, threads, user, working, type Scenario } from "./fixtures.ts";

const root = path.resolve(import.meta.dir, "..");
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

type Line = Record<string, unknown> & { type: string };

function startPi(scenario: Scenario, search: boolean | "inactive" = false) {
	const fake = fakeNexus(scenario);
	const agentDir = mkdtempSync(path.join(os.tmpdir(), "pi-nexus-agent-"));
	if (search) writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["read", "bash", search === "inactive" ? "nexus_read" : "tool_search"] }));
	const inspector = path.join(agentDir, "inspect.ts");
	writeFileSync(inspector, `export default function(pi) {
		pi.registerProvider("discovery-test", {
			baseUrl: "http://127.0.0.1:9", apiKey: "test", api: "openai-completions",
			models: ["a", "b"].map(id => ({ id, name: id, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }))
		});
		pi.registerCommand("search-active", { handler: async (args) => {
			const active = pi.getActiveTools().filter(name => name !== "tool_search");
			pi.setActiveTools(args === "on" ? [...active, "tool_search"] : active);
		} });
		pi.registerCommand("inspect-tools", { handler: async (_args, ctx) => {
			ctx.ui.notify(JSON.stringify({ active: pi.getActiveTools(), tools: pi.getAllTools().filter(t => t.name.startsWith("nexus_")).map(t => ({ name: t.name, exposure: t.exposure })) }), "info");
		} });
	}`);
	const pi = spawn(
		path.join(root, "node_modules", ".bin", "pi"),
		["--mode", "rpc", "--no-session", "-ne", "-ns", "-np", "-nc", "--no-themes", "--no-mcp", "-e", path.join(root, "extensions/nexus/index.ts"), "-e", inspector, ...(search ? ["-e", "builtin:tool-search"] : []), ...(search === "inactive" ? ["--model", "discovery-test/b"] : [])],
		{ cwd: agentDir, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", NEXUS_BIN: fake.bin }, stdio: ["pipe", "pipe", "pipe"] },
	);
	const lines: Line[] = [];
	createInterface({ input: pi.stdout! }).on("line", (line) => {
		if (line.startsWith("{")) lines.push(JSON.parse(line));
	});
	cleanups.push(() => {
		pi.kill();
		fake.cleanup();
		rmSync(agentDir, { recursive: true, force: true });
	});
	const send = (message: object) => pi.stdin!.write(`${JSON.stringify(message)}\n`);
	const waitFor = async (match: (line: Line) => boolean): Promise<Line> => {
		for (let i = 0; i < 300; i++) {
			const found = lines.find(match);
			if (found) return found;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		throw new Error(`no matching line in:\n${lines.map((l) => JSON.stringify(l).slice(0, 300)).join("\n")}`);
	};
	return { send, waitFor, lines, calls: fake.calls };
}

const notes = (lines: Line[]) =>
	lines.flatMap((l) => {
		const e = l.entry as { type: string; customType?: string; data?: { title: string; body: string } } | undefined;
		return l.type === "entry_appended" && e?.customType === "nexus" ? [e.data!] : [];
	});
const notification = (text: string) => (l: Line) => l.type === "extension_ui_request" && l.method === "notify" && l.message === text;

describe("pi-nexus in pi", () => {
	for (const search of [false, true]) {
		test(`model tools are ${search ? "deferred with active search" : "direct without active search"} in real pi`, async () => {
			const pi = startPi({ responses: { threads } }, search);
			pi.send({ id: "inspect", type: "prompt", message: "/inspect-tools" });
			const line = await pi.waitFor((line) => line.method === "notify" && typeof line.message === "string" && line.message.startsWith('{"active":'));
			const result = JSON.parse(line.message as string) as { active: string[]; tools: { name: string; exposure: string }[] };
			expect(result.tools).toHaveLength(10);
			for (const tool of result.tools) {
				expect(tool.exposure).toBe(search ? "deferred" : "direct");
				expect(result.active.includes(tool.name)).toBe(!search);
			}
		}, 30_000);
	}

	test("re-enabling search removes fallback activations but keeps the person's tools in real pi", async () => {
		const pi = startPi({ responses: { threads } }, "inactive");
		let sequence = 0;
		const command = async (message: string) => {
			const id = String(++sequence);
			pi.send({ id, type: "prompt", message });
			await pi.waitFor((line) => line.id === id && line.type === "response");
		};
		const inspect = async () => {
			const start = pi.lines.length;
			await command("/inspect-tools");
			const line = await pi.waitFor((line) => pi.lines.indexOf(line) >= start && line.method === "notify" && typeof line.message === "string" && line.message.startsWith('{"active":'));
			return JSON.parse(line.message as string) as { active: string[]; tools: { name: string; exposure: string }[] };
		};
		const reconcile = async (modelId: string) => {
			const id = String(++sequence);
			pi.send({ id, type: "set_model", provider: "discovery-test", modelId });
			const response = await pi.waitFor((line) => line.id === id && line.type === "response");
			expect(response.success).toBe(true);
		};
		const direct = await inspect();
		expect(direct.tools).toHaveLength(10);
		expect(direct.tools.every((tool) => tool.exposure === "direct" && direct.active.includes(tool.name))).toBe(true);
		for (let cycle = 0; cycle < 2; cycle++) {
			await command("/search-active on");
			await reconcile("a");
			const deferred = await inspect();
			expect(deferred.tools.every((tool) => tool.exposure === "deferred")).toBe(true);
			expect(deferred.active.filter((name) => name.startsWith("nexus_"))).toEqual(["nexus_read"]);
			expect(deferred.active).toEqual(expect.arrayContaining(["read", "bash", "tool_search"]));
			await command("/search-active off");
			await reconcile("b");
			const fallback = await inspect();
			expect(fallback.tools.every((tool) => tool.exposure === "direct" && fallback.active.includes(tool.name))).toBe(true);
		}
	}, 30_000);

	test("the status line shows from the session's start, before any /nexus", async () => {
		const pi = startPi({ responses: { threads } });
		pi.send({ id: "1", type: "get_state" });
		await pi.waitFor((l) => l.method === "setStatus" && l.statusText === "nexus 1 working");
		expect(pi.calls()).toEqual([["threads", "--json"]]);
	}, 30_000);

	test("/nexus list renders threads into the session and sets the status", async () => {
		const pi = startPi({ responses: { threads } });
		pi.send({ id: "1", type: "prompt", message: "/nexus list" });
		await pi.waitFor((l) => l.id === "1" && l.type === "response");
		expect(notes(pi.lines)).toEqual([{ title: "threads", body: expect.stringMatching(new RegExp(`^${idA} +active +working`)) }]);
		await pi.waitFor((l) => l.method === "setStatus" && l.statusText === "nexus 1 working");
	}, 30_000);

	test("/nexus send follows the reply in, then the widget clears", async () => {
		const pi = startPi({
			responses: { threads, send: { submission: 1 } },
			watch: [
				{ event: reset(idA, [user(1, "hi")]) },
				{ event: state(idA, working) },
				{ event: entry(idA, assistant(2, "Hello from the pylon.")), delayMs: 200 },
				{ event: state(idA, idle) },
			],
			watchHold: true,
		});
		pi.send({ id: "1", type: "prompt", message: "/nexus send 0123456789ab hi there" });
		await pi.waitFor(notification(`Stopped following ${idA}: the agent answered`));
		expect(pi.calls().filter((c) => c[0] === "send")).toEqual([["send", "--json", idA, "--", "hi there"]]);
		expect(notes(pi.lines).map((n) => n.body)).toEqual(["> hi", "Hello from the pylon."]);
		// The widget clears after the notice, so wait for it rather than read it at once.
		await pi.waitFor((l) => l.method === "setWidget" && l.widgetLines === undefined);
		const widgets = pi.lines.filter((l) => l.method === "setWidget");
		expect(widgets[0]!.widgetLines).toEqual([`following ${idA}: connecting`]);
	}, 30_000);

	test("/nexus delete asks through pi's select dialog with Keep first", async () => {
		const pi = startPi({ responses: { threads, delete: thread(idA, { status: "deleted" }) } });
		pi.send({ id: "1", type: "prompt", message: `/nexus delete ${idA}` });
		const ask = await pi.waitFor((l) => l.method === "select");
		expect(ask.options).toEqual(["Keep", "Delete"]);
		pi.send({ type: "extension_ui_response", id: ask.id, cancelled: true });
		await pi.waitFor(notification(`Kept ${idA}.`));
		expect(pi.calls().some((c) => c[0] === "delete")).toBe(false);
		pi.send({ id: "2", type: "prompt", message: `/nexus delete ${idA}` });
		const again = await pi.waitFor((l) => l.method === "select" && l.id !== ask.id);
		pi.send({ type: "extension_ui_response", id: again.id, value: "Delete" });
		await pi.waitFor(notification(`Deleted ${idA}.`));
		expect(pi.calls()).toContainEqual(["delete", "--json", idA]);
	}, 30_000);
});
