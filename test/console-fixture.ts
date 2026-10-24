/** A thread for the console's tests: prose, a read, an edit with its diff, a failed command and a running one. */
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { initTheme, theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { getMarkdownTheme, type KeybindingsManager as Keybindings, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { Display } from "../extensions/nexus/console/transcript.ts";
import type { Settings, SettingsStore, Viewed } from "../extensions/nexus/store.ts";
import type { AssistantMessage, ListeningPort, LiveRun, Message, Preview, RenderedEntry, ThreadDetail, ThreadState, ToolResultMessage } from "../extensions/nexus/contract.ts";
import { idA, thread } from "./fixtures.ts";

export const asked = 1_700_000_000_000;

const message = (id: number, ...model: Message[]): RenderedEntry => ({ entry: { id, model }, text: `entry ${id}` });
const answer = (content: AssistantMessage["content"], stopReason = "toolUse"): AssistantMessage => ({ role: "assistant", content, stopReason, model: "demo-model" });
const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall" as const, id, name, arguments: args });
const result = (id: string, name: string, text: string, extra: Partial<ToolResultMessage> = {}): ToolResultMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName: name,
	content: [{ type: "text", text }],
	isError: false,
	...extra,
});

/** A call ID as the control plane serves one, with a `|` in it. */
export const runningCall = "call_PdOe7x|fc_0895ab";

export const probe = "export async function probe(url: string) {\n\tawait sleep(1000);\n\treturn fetch(url);\n}\n";

/** An edit's stored details as a real pylon keeps them: pi's own diff with line numbers, and a unified patch. */
export const editDetails = {
	diff: " 1 export async function probe(url: string) {\n-2 \tawait sleep(1000);\n+2 \tawait sleep(backoff(attempt));\n 3 \treturn fetch(url);",
	firstChangedLine: 2,
	patch:
		"--- src/probe.ts\n+++ src/probe.ts\n@@ -1,4 +1,4 @@\n export async function probe(url: string) {\n-\tawait sleep(1000);\n+\tawait sleep(backoff(attempt));\n \treturn fetch(url);\n }\n",
};

export const entries: RenderedEntry[] = [
	{ entry: { id: 0 }, text: "" },
	message(1, { role: "user", content: "Fix the retry in probe.ts so it backs off.", timestamp: asked }),
	message(2, answer([{ type: "text", text: "I'll read the **probe** first." }, call("call-read", "read", { path: "src/probe.ts" })])),
	message(3, result("call-read", "read", probe)),
	message(
		4,
		answer([
			{ type: "text", text: "The retry waits a fixed second. I'll make it back off." },
			call("call-edit", "edit", { path: "src/probe.ts", edits: [{ oldText: "\tawait sleep(1000);", newText: "\tawait sleep(backoff(attempt));" }] }),
		]),
	),
	message(5, result("call-edit", "edit", "Successfully replaced 1 block(s) in src/probe.ts.", { details: editDetails })),
	message(6, answer([call("call-test", "bash", { command: "npm test" })])),
	message(7, result("call-test", "bash", "FAIL probe.test.ts\n  expected a delay of 1000\n\nCommand exited with code 1", { isError: true })),
	message(8, answer([{ type: "text", text: "One test still expects the old delay. I'll update it and run the suite again." }, call(runningCall, "bash", { command: "npm test -- --bail" })])),
];

export const webPreview: Preview = { service: "web", ready: true, url: "https://firebat.example.ts.net:8443/" };
/** The web service's port, with its preview, and a server the agent started by hand, with none yet. */
export const ports: ListeningPort[] = [
	{ port: 5173, service: "web", preview: webPreview },
	{ port: 8080, service: null, preview: null },
];
export const working: ThreadState = { status: "active", run: "working", parkedTasks: 0, queued: 1, pylon: "running", failed: null, ports };
export const live: LiveRun = { queued: ["also update the docs"], tools: [{ callId: runningCall, output: "> probe.test.ts\n  ✓ backs off" }], partial: null, retry: null };

export const detail: ThreadDetail = {
	thread: thread(idA, { project: "nexus", title: "Fix the probe retry", agentTurnRunning: true, conversationId: "conv-1", lastHumanActivityAt: asked, lastAgentActivityAt: asked }),
	pylon: { id: "py-0123", node: "firebat", actualState: "running", failed: null, observedAt: new Date(asked).toISOString(), retryRefused: null },
	sessions: [{ harness: "pi", herdrPane: "%3", status: "working", harnessSessionId: "abc" }],
	previews: [webPreview],
	ports,
	outputs: [
		{ kind: "branch", ref: "nexus/th-0123456789ab" },
		{ kind: "preview", ref: "web" },
	],
	agent: { parkedTasks: 0 },
	desired: "running",
	attach: "herdr --session nexus",
};

export function piTheme(): Theme {
	initTheme("dark");
	return theme as Theme;
}

export const keybindings = () => new KeybindingsManager() as unknown as Keybindings;

export const display = (): Display => ({ outputPad: 1, hideThinkingBlock: false, editorPaddingX: 0, markdownTheme: getMarkdownTheme() });

/** A terminal of `rows` lines that counts its render requests. */
export function fakeTui(rows = 40, columns = 100) {
	const tui = { terminal: { rows, columns }, renders: 0, requestRender() {
		tui.renders++;
	} };
	return tui as typeof tui & TUI;
}

/** `lines` without colour or cursor codes, trimmed at the end. */
export const plain = (lines: readonly string[]) =>
	lines
		.map((l) => l.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b_[^\x07]*\x07/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trimEnd())
		.join("\n");

/** Looks kept in memory, so a test never touches the user's own. Every thread counts as looked at from `since`. */
export function memoryViewed(since = 0): Viewed & { looks: [string, number][] } {
	const threads: Record<string, number> = {};
	const looks: [string, number][] = [];
	return {
		looks,
		read: () => ({ since, threads: { ...threads } }),
		mark(thread, at) {
			looks.push([thread, at]);
			threads[thread] = Math.max(threads[thread] ?? 0, at);
		},
		prune(kept, listedAt) {
			for (const [thread, at] of Object.entries(threads)) if (!kept.has(thread) && at < listedAt) delete threads[thread];
		},
	};
}

/** Settings kept in memory, with each write recorded. */
export function memorySettings(settings: Settings = { strip: true }): SettingsStore & { writes: Settings[] } {
	let kept = settings;
	const writes: Settings[] = [];
	return {
		writes,
		read: () => kept,
		write(next) {
			writes.push(next);
			kept = next;
		},
	};
}

/** The extension's stores, in memory. */
export const memoryStores = (viewed = memoryViewed(), settings = memorySettings()) => ({ viewed, settings });
