/** A streaming answer: `nexus watch` prints a live event up to ten times a second, and the thread redraws at most that often. */
import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { createNexus, type Nexus } from "../extensions/nexus/cli.ts";
import { Console } from "../extensions/nexus/console/index.ts";
import { ThreadScreen } from "../extensions/nexus/console/thread-screen.ts";
import type { WatchEvent } from "../extensions/nexus/contract.ts";
import nexusExtension from "../extensions/nexus/index.ts";
import { detail, display, entries, fakeTui, keybindings, memoryScope, memorySettings, memoryStores, memoryViewed, piTheme, plain, working } from "./console-fixture.ts";
import { assistant, entry, fakeNexus, idA, reset, state, threads } from "./fixtures.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	jest.useRealTimers();
	cleanups.splice(0).forEach((cleanup) => cleanup());
});

/** The partial answer after `n` live events: one more short paragraph each time. */
const partialAfter = (n: number) => Array.from({ length: n }, (_, i) => `Step ${i + 1} of the plan.`).join("\n\n");
const live = (partial: string | null): WatchEvent => ({ type: "live", thread: idA, queued: [], tools: [], partial, retry: null });
const answer = partialAfter(12);
/** The thread before the answer: everything up to the last tool result, so the run is between calls. */
const before = entries.slice(0, 8);

/** Each draw of the thread, as its screen shows it right after. */
function recordDraws() {
	const draw = ThreadScreen.prototype.setView;
	const frames: { at: number; text: string }[] = [];
	const spy = spyOn(ThreadScreen.prototype, "setView").mockImplementation(function (this: ThreadScreen, view) {
		draw.call(this, view);
		frames.push({ at: Date.now(), text: plain(this.render(100)) });
	});
	cleanups.push(() => spy.mockRestore());
	return frames;
}

const count = (text: string, part: string) => text.split(part).length - 1;
/** The transcript's last line, just above the blank line over the editor. */
const lastBodyLine = (text: string) => {
	const lines = text.split("\n");
	const editorTop = lines.findIndex((l, i) => l.startsWith("─") && lines[i - 1] === "");
	return lines.slice(0, editorTop - 1).filter((l) => l.trim() !== "").at(-1)?.trim();
};

describe("a streaming answer", () => {
	test("redraws at most every 100 ms, draws an answer with the live event after it once, and keeps to the end", async () => {
		jest.useFakeTimers();
		const frames = recordDraws();
		let emit!: (event: WatchEvent) => void;
		const nexus: Nexus = {
			bin: "nexus",
			run: async (args) => (args[0] === "show" ? detail : args[0] === "nodes" ? [] : null),
			watch(_thread, onEvent, signal) {
				emit = onEvent;
				return new Promise((resolve) => signal.addEventListener("abort", () => resolve()));
			},
			attach: async () => {},
		};
		const closed = new AbortController();
		cleanups.push(() => closed.abort());
		let screen!: Component;
		const ui = {
			custom(factory: (...args: unknown[]) => Component) {
				screen = factory(fakeTui(30, 100), piTheme(), keybindings(), () => {});
				return new Promise(() => {});
			},
		};
		void new Console(nexus, closed.signal, memoryViewed(), new Map(), memoryScope(), () => {}, memorySettings(), display).thread(ui as never, "/tmp", idA);
		const text = () => plain(screen.render(100));

		// The lines a poll prints together draw together, once.
		emit(reset(idA, before));
		emit(state(idA, working));
		expect(frames).toHaveLength(0);
		jest.advanceTimersByTime(0);
		expect(frames).toHaveLength(1);

		// Forty live events a second for a second draw about ten times, the latest each time.
		for (let n = 1; n <= 40; n++) {
			jest.advanceTimersByTime(25);
			emit(live(partialAfter(Math.ceil(n / 4))));
		}
		jest.advanceTimersByTime(100);
		const streamed = frames.slice(1);
		expect(streamed.length).toBeGreaterThanOrEqual(9);
		expect(streamed.length).toBeLessThanOrEqual(11);
		expect(streamed.at(-1)!.text).toContain("Step 10 of the plan.");
		// The screen follows the end as the answer grows.
		for (const f of streamed) expect(lastBodyLine(f.text)).toMatch(/^Step \d+ of the plan\.$/);
		expect(lastBodyLine(text())).toBe("Step 10 of the plan.");

		// Scrolled up, the person stays where they are while the answer goes on.
		screen.handleInput!("\x1b[5~");
		const shown = text().split("\n").slice(0, 10).join("\n");
		emit(live(partialAfter(11)));
		jest.advanceTimersByTime(200);
		expect(text().split("\n").slice(0, 10).join("\n")).toBe(shown);
		expect(text()).toMatch(/↓ \d+ more lines, G follows the end/);
		screen.handleInput!("\x1b[6~");
		screen.handleInput!("\x1b[6~");
		screen.handleInput!("\x1b[6~");

		// The CLI prints the committed answer, then the live event that drops it from the partial answer. No frame shows
		// it twice, and the screen is back at the end.
		const settled = frames.length;
		emit(entry(idA, assistant(9, answer)));
		emit(live(null));
		emit(state(idA, { ...working, run: "idle", queued: 0 }));
		jest.advanceTimersByTime(200);
		expect(frames.length).toBe(settled + 1);
		for (const f of frames) expect(count(f.text, "Step 12 of the plan.")).toBeLessThanOrEqual(1);
		expect(count(text(), "Step 12 of the plan.")).toBe(1);
		expect(lastBodyLine(text())).toBe("Step 12 of the plan.");

		// Closing the thread leaves no draw pending.
		emit(live("late"));
		closed.abort();
		jest.advanceTimersByTime(200);
		expect(frames.length).toBe(settled + 1);
	});

	test("the fake CLI at 10 Hz draws every answer step at least 100 ms apart, and the whole answer once", async () => {
		const frames = recordDraws();
		const steps = 20;
		const fake = fakeNexus({
			responses: { threads, show: detail, wake: null, nodes: [], projects: [] },
			watch: [
				{ event: reset(idA, before) },
				{ event: state(idA, working) },
				...Array.from({ length: steps }, (_, i) => ({ event: live(partialAfter(Math.min(12, i + 1))), delayMs: 100 })),
				{ event: entry(idA, assistant(9, answer)), delayMs: 100 },
				{ event: live(null) },
				{ event: state(idA, { ...working, run: "idle", queued: 0 }) },
			],
			watchHold: true,
		});
		cleanups.push(fake.cleanup);
		let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
		const handlers = new Map<string, () => void>();
		const pi = {
			registerEntryRenderer() {},
			registerTool() {},
			registerCommand: (_name: string, options: { handler: typeof command }) => (command = options.handler),
			on: (event: string, handler: () => void) => handlers.set(event, handler),
			appendEntry() {},
		} as unknown as ExtensionAPI;
		let screen: Component | undefined;
		const ctx = {
			hasUI: true,
			cwd: "/tmp",
			ui: {
				notify() {},
				setStatus() {},
				setWidget() {},
				custom(factory: (...args: unknown[]) => Component) {
					screen = factory(fakeTui(30, 100), piTheme(), keybindings(), () => {});
					return new Promise(() => {});
				},
			},
		} as unknown as ExtensionCommandContext;
		nexusExtension(pi, createNexus(fake.bin), display, memoryStores());
		cleanups.push(() => handlers.get("session_shutdown")?.());
		void command(`open ${idA}`, ctx);
		// The last frame comes once the committed answer lands, about 2.2 s in.
		for (let i = 0; i < 200 && !frames.some((f) => /Step 12 of the plan\./.test(f.text) && !f.text.includes("Working")); i++) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
		const text = plain(screen!.render(100));
		expect(count(text, "Step 12 of the plan.")).toBe(1);
		expect(lastBodyLine(text)).toBe("Step 12 of the plan.");
		for (const f of frames) expect(count(f.text, "Step 12 of the plan.")).toBeLessThanOrEqual(1);
		// Every step got a draw of its own, none closer than the 100 ms the redraws keep apart, give or take the clock.
		expect(frames.length).toBeLessThanOrEqual(steps + 3);
		expect(frames.length).toBeGreaterThanOrEqual(steps / 2);
		const gaps = frames.slice(1).map((f, i) => f.at - frames[i]!.at);
		expect(Math.min(...gaps)).toBeGreaterThanOrEqual(95);
	});
});
