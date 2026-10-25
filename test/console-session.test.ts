/** The console's views over a session's life, with a Nexus whose replies the test hands out, and fake timers. */
import { afterEach, describe, expect, jest, test } from "bun:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { Nexus } from "../extensions/nexus/cli.ts";
import { Console } from "../extensions/nexus/console/index.ts";
import type { WatchEvent } from "../extensions/nexus/contract.ts";
import { detail, display, entries, fakeTui, keybindings, live, memoryScope, memorySettings, memoryViewed, piTheme, plain, working } from "./console-fixture.ts";
import { idA, reset, row, state } from "./fixtures.ts";

afterEach(() => jest.useRealTimers());

/** A Nexus whose every run waits until the test answers it, and whose watch sends what the test emits. */
function heldNexus() {
	const runs: { args: string[]; answer(value: unknown): void }[] = [];
	let onEvent: (event: WatchEvent) => void = () => {};
	const nexus: Nexus = {
		bin: "nexus",
		run: (args) => new Promise((resolve) => runs.push({ args: [...args], answer: resolve })),
		watch(_thread, handler, signal) {
			onEvent = handler;
			return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
		},
		attach: async () => {},
		version: async () => "nexus 0.8.0\n",
	};
	const of = (command: string) => runs.filter((r) => r.args[0] === command);
	return { nexus, runs, of, emit: (event: WatchEvent) => onEvent(event) };
}

/** A ui whose custom() mounts the view and, like pi's overlay reset, never disposes it. */
function heldUi() {
	const shown: Component[] = [];
	const ui = {
		custom: (factory: (...args: unknown[]) => Component) =>
			new Promise(() => {
				shown.push(factory(fakeTui(60, 100), piTheme(), keybindings(), () => {}));
			}),
	} as unknown as ExtensionUIContext;
	const type = (text: string) => {
		for (const ch of text) shown.at(-1)!.handleInput!(ch);
		shown.at(-1)!.handleInput!("\r");
	};
	return { ui, type, text: () => plain(shown.at(-1)!.render(100)) };
}

const flush = async () => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};

function open() {
	jest.useFakeTimers();
	const n = heldNexus();
	const closed = new AbortController();
	const u = heldUi();
	void new Console(n.nexus, closed.signal, memoryViewed(), new Map(), memoryScope(), () => {}, memorySettings(), display).thread(u.ui, "/tmp", idA);
	n.emit(reset(idA, entries));
	n.emit(state(idA, working));
	n.emit({ type: "live", thread: idA, ...live });
	return { ...n, ...u, closed };
}

describe("console over a session", () => {
	test("the session's end stops a view pi never disposed, so it runs no more CLI commands", async () => {
		const s = open();
		expect(jest.getTimerCount()).toBeGreaterThan(0);
		s.closed.abort();
		expect(jest.getTimerCount()).toBe(0);
		const before = s.runs.length;
		jest.advanceTimersByTime(60_000);
		await flush();
		expect(s.runs.length).toBe(before);
	});

	test("an older detail landing after a newer one is dropped", async () => {
		const s = open();
		// The first state asked for the detail; a changed state asks again.
		s.emit(state(idA, { ...working, queued: 0 }));
		const [older, newer] = s.of("show");
		newer!.answer(detail);
		await flush();
		older!.answer({ ...detail, thread: { ...detail.thread, conversationId: null } });
		await flush();
		expect(s.text()).not.toContain("This thread has no agent conversation.");
		expect(s.text()).toContain("nexus / Fix the probe retry");
	});

	test("an action's refreshed detail is what shows, even with an older one still on its way", async () => {
		const s = open();
		const [older] = s.of("show");
		s.type("/archive");
		await flush();
		s.of("archive")[0]!.answer(detail.thread);
		await flush();
		const [, refreshed] = s.of("show");
		refreshed!.answer({ ...detail, pylon: { ...detail.pylon, node: "nuc" } });
		await flush();
		older!.answer(detail);
		await flush();
		expect(s.text()).toContain("pylon running on nuc");
		expect(s.text()).not.toContain("on firebat");
	});

	test("an older thread list landing after a newer one is dropped", async () => {
		jest.useFakeTimers();
		const n = heldNexus();
		const u = heldUi();
		void new Console(n.nexus, new AbortController().signal, memoryViewed(), new Map(), memoryScope(), () => {}, memorySettings(), display).browse(u.ui, "/tmp");
		// No agent works, so /nexus opens the picker.
		n.of("threads")[0]!.answer([]);
		await flush();
		jest.advanceTimersByTime(5_000);
		const [, older, newer] = n.of("threads");
		for (const projects of n.of("projects")) projects.answer([]);
		newer!.answer([row(idA, { title: "The newer list" })]);
		await flush();
		older!.answer([row(idA, { title: "The older list" })]);
		await flush();
		expect(u.text()).toContain("The newer list");
		expect(u.text()).not.toContain("The older list");
	});
});
