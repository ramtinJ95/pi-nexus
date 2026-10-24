/**
 * Builds the screenshot demo in the directory given as the first argument:
 *
 * - work/, a project for the real pi session, with src/probe.ts and test.sh;
 * - nexus, a fake nexus binary whose thread holds the same conversation, its tool results made by pi's own tools on
 *   a copy of work/, so both sides show the same output;
 * - agent/, a pi agent directory for the session, whose looks store dates from before the other threads answered,
 *   so the picker marks one as new and one, whose pylon failed, as needing you;
 * - a line on stdout with the thread's ID.
 *
 * Two projects, demo and site, list beside two nodes, and `nexus project add` adds a third, which the projects list
 * from then on.
 *
 * The pylon listens on three ports: the web service's, previewed, an ad hoc server's with no preview yet, which
 * `/open` publishes and `/unpublish` then closes, each slowly enough to show it, and a service's with no preview.
 *
 * With `stream`, the second run of the suite has passed, and the watch streams the agent's closing answer as live
 * events ten times a second, then commits it.
 *
 * Usage: bun test/demo/build.ts <dir> [stream]
 */
import { chmodSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createBashToolDefinition, createEditToolDefinition, createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RenderedEntry } from "../../extensions/nexus/contract.ts";
import { followUp, model, probe, prompt, runningOutput, steps, testScript } from "./conversation.ts";

const dir = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: bun test/demo/build.ts <dir> [stream]");
const stream = process.argv[3] === "stream";
const thread = "th-0123456789ab";

const work = path.join(dir, "work");
mkdirSync(path.join(work, "src"), { recursive: true });
writeFileSync(path.join(work, "src/probe.ts"), probe);
writeFileSync(path.join(work, "test.sh"), testScript);
chmodSync(path.join(work, "test.sh"), 0o755);

// The tools run on a copy, so the real pi session finds work/ as it was.
const copy = path.join(dir, "copy");
cpSync(work, copy, { recursive: true });
const tools: Record<string, ReturnType<typeof createReadToolDefinition>> = {
	read: createReadToolDefinition(copy) as never,
	edit: createEditToolDefinition(copy) as never,
	bash: createBashToolDefinition(copy) as never,
};

const asked = Date.now() - 72_000;
const entries: RenderedEntry[] = [
	{ entry: { id: 0 }, text: "" },
	{ entry: { id: 1, model: [{ role: "user", content: prompt, timestamp: asked }] }, text: `> ${prompt}` },
];
let id = 2;
for (const step of steps) {
	const content = [...(step.text ? [{ type: "text" as const, text: step.text }] : []), { type: "toolCall" as const, ...step.call }];
	entries.push({ entry: { id: id++, model: [{ role: "assistant", content, stopReason: "toolUse", model }] }, text: step.text ?? "" });
	if (step.call.id === "call-again") {
		if (!stream) break;
		// The real suite would sleep, so its result is written out.
		const output = `${runningOutput}\n  ✓ keeps the first try immediate\n\n2 passed`;
		entries.push({ entry: { id: id++, model: [{ role: "toolResult", toolCallId: step.call.id, toolName: "bash", content: [{ type: "text", text: output }], isError: false }] }, text: "" });
		break;
	}
	const result = await tools[step.call.name]!.execute(step.call.id, step.call.arguments as never, undefined, undefined, undefined as never);
	entries.push({
		entry: {
			id: id++,
			model: [{ role: "toolResult", toolCallId: step.call.id, toolName: step.call.name, content: result.content, details: result.details, isError: (result as { isError?: boolean }).isError ?? false }],
		},
		text: "",
	});
}

const host = "https://firebat.tail0000.ts.net";
const web = { pylon: "py-demo", service: "web", httpsPort: 8443, ready: true, url: `${host}:8443/` };
const ports = [
	{ port: 5173, service: "web", preview: web },
	{ port: 8080, service: null, preview: null },
	{ port: 9000, service: "api", preview: null },
];
const working = { status: "active", run: "working", parkedTasks: 0, queued: stream ? 0 : 1, pylon: "running", failed: null, ports };
const now = new Date().toISOString();
const detail = {
	thread: { id: thread, title: "Fix the probe retry", project: "demo", status: "active", agentTurnRunning: true, createdAt: asked, conversationId: "conv-demo", lastHumanActivityAt: asked, lastAgentActivityAt: Date.now() },
	pylon: { id: "py-demo", node: "firebat", actualState: "running", failed: null, observedAt: now, retryRefused: null },
	sessions: [{ harness: "pi", herdrPane: "%1", status: "working", harnessSessionId: null }],
	previews: [web],
	ports,
	outputs: [
		{ kind: "branch", ref: `nexus/${thread}` },
		{ kind: "preview", ref: "web" },
	],
	agent: { parkedTasks: 0 },
	desired: "running",
	attach: "herdr --session nexus",
};
const own = { pylon: "py-demo", service: "port-8080", httpsPort: 8444, ready: true, url: `${host}:8444/` };
const opened = { ...detail, previews: [web, own], ports: ports.map((p) => (p.port === 8080 ? { ...p, preview: own } : p)) };
/** The closing answer, a word more in each live event. */
const answer =
	"The suite passes now. The retry in `src/probe.ts` waits `backoff(attempt)` instead of a fixed second, so a failing probe tries again after 100 ms, then 200 ms, 400 ms and so on, up to 5 s.\n\n" +
	"- The first try still goes at once.\n- `probe.test.ts` expects the growing delays rather than the old 1000 ms.\n\n" +
	"I left the docs as they were, since they never named the delay.";
const words = answer.split(/(?<= )/);
const partials = words.map((_, i) => words.slice(0, i + 1).join(""));
const live = (partial: string | null) => ({ type: "live", thread, queued: [], tools: [], partial, retry: null });
const watch = stream
	? [
			{ event: { type: "reset", thread, entries } },
			{ event: { type: "state", thread, ...working } },
			...partials.map((partial) => ({ event: live(partial), delayMs: 100 })),
			{ event: { type: "entry", thread, entry: { id: id++, model: [{ role: "assistant", content: [{ type: "text", text: answer }], stopReason: "stop", model }] }, text: answer }, delayMs: 100 },
			{ event: live(null) },
			{ event: { type: "state", thread, ...working, run: "idle" } },
		]
	: [
			{ event: { type: "reset", thread, entries } },
			{ event: { type: "state", thread, ...working } },
			{ event: { type: "live", thread, queued: [followUp], tools: [{ callId: "call-again", output: runningOutput }], partial: null, retry: null } },
		];
const other = (id: string, title: string, extra: object) => ({
	...detail.thread,
	id,
	title,
	agentTurnRunning: false,
	createdAt: asked - 3_600_000,
	lastHumanActivityAt: asked - 3_000_000,
	lastAgentActivityAt: asked - 600_000,
	desired: "running",
	pylon: { node: "firebat", actualState: "running", failed: null },
	...extra,
});
const threads = [
	{ ...detail.thread, desired: "running", pylon: { node: "firebat", actualState: "running", failed: null } },
	other("th-0123456789cd", "Document the retry", {}),
	other("th-0123456789ef", "Upgrade the probe's deps", { pylon: { node: "firebat", actualState: "failed", failed: "git clone: permission denied" } }),
	other("th-00000000aaaa", "Spike: probe over HTTP/3", { status: "archived", desired: "paused", pylon: { node: "firebat", actualState: "paused", failed: null } }),
	other("th-0000000051e0", "Landing page copy", { project: "site", pylon: { node: "nuc", actualState: "paused", failed: null }, desired: "paused" }),
];
const project = (id: string, repoUrl: string, defaultNode: string) => ({
	id,
	repoUrl,
	defaultBranch: "main",
	defaultNode,
	resources: { cpus: 2, memoryGiB: 4, diskGiB: 20 },
	allowedHosts: [],
	secrets: [],
	logins: [],
	preSetup: null,
});
const scenario = {
	responses: {
		threads,
		show: detail,
		wake: null,
		nodes: [
			{ name: "firebat", tailnetHost: "firebat.tail0000.ts.net", state: "online" },
			{ name: "nuc", tailnetHost: "nuc.tail0000.ts.net", state: "offline" },
		],
		projects: [project("demo", "git@github.com:ramtinJ95/probe-demo.git", "firebat"), project("site", "git@github.com:ramtinJ95/site.git", "nuc")],
		preview: own,
		unpreview: null,
	},
	// The details list port 8080's preview once it opens, and stop listing it once it is unpublished.
	after: { preview: { show: opened }, unpreview: { show: detail } },
	// Long enough to capture the port opening and closing.
	delayMs: { preview: 30_000, unpreview: 30_000 },
	watch,
	watchHold: true,
};

const scenarioFile = path.join(dir, "scenario.json");
const log = path.join(dir, "calls.log");
const bin = path.join(dir, "nexus");
writeFileSync(scenarioFile, JSON.stringify(scenario));
mkdirSync(path.join(dir, "agent/pi-nexus"), { recursive: true });
writeFileSync(path.join(dir, "agent/pi-nexus/viewed.json"), JSON.stringify({ since: asked - 1_800_000, threads: {} }));
writeFileSync(log, "");
const fake = path.join(import.meta.dir, "../fake-nexus.mjs");
writeFileSync(bin, `#!/bin/sh\nFAKE_NEXUS=${JSON.stringify(scenarioFile)} FAKE_NEXUS_LOG=${JSON.stringify(log)} exec node ${JSON.stringify(fake)} "$@"\n`);
chmodSync(bin, 0o755);
console.log(thread);
