import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Nexus } from "../extensions/nexus/cli.ts";
import type { RenderedEntry, Thread, ThreadState, WatchEvent } from "../extensions/nexus/thread.ts";

export const idA = "th-0123456789ab";
export const idB = "th-0123456789cd";
export const idC = "th-ffff00001111";

export function thread(id: string, extra: Partial<Thread> = {}): Thread {
	return { id, title: `title of ${id}`, project: "acme", status: "active", agentTurnRunning: false, createdAt: 0, ...extra };
}

export const threads = [thread(idA, { agentTurnRunning: true }), thread(idB), thread(idC, { status: "archived" })];

export const head: RenderedEntry = { entry: { id: 0 }, text: "" };
export const user = (id: number, text: string): RenderedEntry => ({ entry: { id, model: [{ role: "user", content: text }] }, text: `> ${text}` });
export const assistant = (id: number, text: string, stopReason = "stop"): RenderedEntry => ({
	entry: { id, model: [{ role: "assistant", content: [{ type: "text", text }], stopReason }] },
	text,
});
export const toolResult = (id: number): RenderedEntry => ({
	entry: { id, model: [{ role: "toolResult", content: [{ type: "text", text: "ok" }] }] },
	text: "[result] bash: ok",
});
export const toolCall = (id: number): RenderedEntry => ({
	entry: { id, model: [{ role: "assistant", content: [{ type: "toolCall", name: "bash" }], stopReason: "toolUse" }] },
	text: "[tool] bash {}",
});

export const idle: ThreadState = { status: "active", run: "idle", parkedTasks: 0, queued: 0, pylon: "running", failed: null };
export const working: ThreadState = { ...idle, run: "working" };

export const reset = (thread: string, entries: RenderedEntry[]): WatchEvent => ({ type: "reset", thread, entries });
export const entry = (thread: string, e: RenderedEntry): WatchEvent => ({ type: "entry", thread, ...e });
export const state = (thread: string, s: ThreadState): WatchEvent => ({ type: "state", thread, ...s });

export interface Scenario {
	responses?: Record<string, unknown>;
	fail?: Record<string, { exit: number; kind?: string; error?: string; stderr?: string }>;
	watch?: { event: WatchEvent | string; delayMs?: number }[];
	watchHold?: boolean;
	watchExitDelayMs?: number;
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
	};
}
