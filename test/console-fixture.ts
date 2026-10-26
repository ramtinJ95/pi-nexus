/** A thread for the console's tests: prose, a read, an edit with its diff, a failed command and a running one. */
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { initTheme, theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { getMarkdownTheme, type KeybindingsManager as Keybindings, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { Display } from "../extensions/nexus/console/transcript.ts";
import { Scope } from "../extensions/nexus/scope.ts";
import type { Settings, SettingsStore } from "../extensions/nexus/store.ts";
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
	seenAt: null,
	lastReplyAt: null,
	attention: "working",
	pylon: { id: "py-0123", node: "firebat", actualState: "running", failed: null, observedAt: new Date(asked).toISOString(), retryRefused: null },
	sessions: [{ id: "%3", state: "running", message: null, harness: "pi", herdrPane: "%3", status: "working", harnessSessionId: "abc" }],
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

/** A terminal of `rows` lines that counts its render requests, and records when it stops, starts and is written. */
export function fakeTui(rows = 40, columns = 100) {
	const events: string[] = [];
	const tui = {
		terminal: { rows, columns, write: (data: string) => void events.push(`write ${data}`) },
		renders: 0,
		events,
		requestRender(force?: boolean) {
			tui.renders++;
			if (force) events.push("redraw");
		},
		stop: () => void events.push("stop"),
		start: () => void events.push("start"),
	};
	return tui as typeof tui & TUI;
}

/** `lines` without colour or cursor codes, trimmed at the end. */
export const plain = (lines: readonly string[]) =>
	lines
		.map((l) => l.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b_[^\x07]*\x07/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trimEnd())
		.join("\n");

/** Settings kept in memory, with each change recorded. */
export function memorySettings(settings: Partial<Settings> = {}): SettingsStore & { writes: Partial<Settings>[] } {
	let kept: Settings = { strip: true, project: null, ...settings };
	const writes: Partial<Settings>[] = [];
	return {
		writes,
		read: () => kept,
		update(change) {
			writes.push(change);
			kept = { ...kept, ...change };
		},
	};
}

/** The scope of every project, kept in memory. */
export const memoryScope = (settings: Partial<Settings> = {}) => new Scope(memorySettings(settings), () => {}, () => {});

/** The extension's stores, in memory. */
export const memoryStores = (settings = memorySettings()) => ({ settings });
