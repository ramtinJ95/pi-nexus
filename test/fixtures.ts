import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Nexus } from "../extensions/nexus/cli.ts";
import type { RenderedEntry, Thread, ThreadRow, ThreadState, WatchEvent } from "../extensions/nexus/contract.ts";

export const idA = "th-0123456789ab";
export const idB = "th-0123456789cd";
export const idC = "th-ffff00001111";

export function thread(id: string, extra: Partial<Thread> = {}): Thread {
	return {
		id,
		title: `title of ${id}`,
		project: "acme",
		status: "active",
		agentTurnRunning: false,
		createdAt: 0,
		lastAgentActivityAt: 0,
		lastHumanActivityAt: 0,
		conversationId: `conv-${id}`,
		...extra,
	};
}

/** A thread as a row of `nexus threads`, with its pylon running and nothing to show unless `extra` says otherwise. */
export function row(id: string, extra: Partial<ThreadRow> = {}): ThreadRow {
	return { ...thread(id), seenAt: null, lastReplyAt: null, attention: null, desired: "running", pylon: { node: "firebat", actualState: "running", failed: null }, ...extra };
}

export const threads = [row(idA, { agentTurnRunning: true }), row(idB), row(idC, { status: "archived" })];

export const head: RenderedEntry = { entry: { id: 0 }, text: "" };
export const user = (id: number, text: string): RenderedEntry => ({ entry: { id, model: [{ role: "user", content: text, timestamp: 0 }] }, text: `> ${text}` });
export const assistant = (id: number, text: string, stopReason = "stop"): RenderedEntry => ({
	entry: { id, model: [{ role: "assistant", content: [{ type: "text", text }], stopReason, model: "demo-model" }] },
	text,
});
export const toolResult = (id: number): RenderedEntry => ({
	entry: { id, model: [{ role: "toolResult", toolCallId: `call-${id - 1}`, toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false }] },
	text: "[result] bash: ok",
});
export const toolCall = (id: number): RenderedEntry => ({
	entry: { id, model: [{ role: "assistant", content: [{ type: "toolCall", id: `call-${id}`, name: "bash", arguments: {} }], stopReason: "toolUse", model: "demo-model" }] },
	text: "[tool] bash {}",
});

export const idle: ThreadState = { status: "active", run: "idle", parkedTasks: 0, queued: 0, pylon: "running", failed: null, ports: [] };
export const working: ThreadState = { ...idle, run: "working" };

export const reset = (thread: string, entries: RenderedEntry[]): WatchEvent => ({ type: "reset", thread, entries });
export const entry = (thread: string, e: RenderedEntry): WatchEvent => ({ type: "entry", thread, ...e });
export const state = (thread: string, s: ThreadState): WatchEvent => ({ type: "state", thread, ...s });

export interface Scenario {
	responses?: Record<string, unknown>;
	/** Replies that replace `responses` once the command they are under has answered. */
	after?: Record<string, Record<string, unknown>>;
	fail?: Record<string, { exit: number; kind?: string; error?: string; stderr?: string }>;
	watch?: { event: WatchEvent | string; delayMs?: number }[];
	watchHold?: boolean;
	watchExitDelayMs?: number;
	/** How long a command takes to answer, by command. */
	delayMs?: Record<string, number>;
	/** The signal that stops `attach`, as Ctrl+C stops the CLI. */
	attachSignal?: string;
	/** What `nexus --version` prints after `nexus `, 0.17.0 unless given. */
	version?: string;
}

const fakeSource = path.join(import.meta.dir, "fake-nexus.mjs");

/** A fake nexus binary for one scenario. `calls()` returns the argv of every run, in order. */
export function fakeNexus(scenario: Scenario) {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-nexus-"));
	const scenarioFile = path.join(dir, "scenario.json");
	const log = path.join(dir, "calls.log");
	const bin = path.join(dir, "nexus");
	writeFileSync(scenarioFile, JSON.stringify(scenario));
	writeFileSync(log, "");
	writeFileSync(bin, `#!/bin/sh\nFAKE_NEXUS=${JSON.stringify(scenarioFile)} FAKE_NEXUS_LOG=${JSON.stringify(log)} exec node ${JSON.stringify(fakeSource)} "$@"\n`);
	chmodSync(bin, 0o755);
	return {
		bin,
		calls: (): string[][] => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

/**
 * A Nexus whose watch replays `polls`, each a burst of events as one CLI poll prints them, `gapMs` apart, and then
 * waits for its signal, as a live watch does.
 */
export function scriptedNexus(polls: WatchEvent[][], gapMs = 250): Nexus {
	return {
		bin: "nexus",
		async run(args) {
			return args[0] === "threads" ? threads : null;
		},
		async watch(_thread, onEvent, signal) {
			for (const [i, poll] of polls.entries()) {
				if (i > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
				if (signal.aborted) return;
				for (const event of poll) onEvent(event);
			}
			if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
		},
		async attach() {},
		async version() {
			return "nexus 0.17.0\n";
		},
	};
}
