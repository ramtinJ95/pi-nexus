import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Action } from "../extensions/nexus/commands.ts";
import { ThreadScreen, type ScreenEnd } from "../extensions/nexus/console/thread-screen.ts";
import type { OpenedSession, Preview, RenderedEntry, Session, ThreadDetail, ToolResultMessage } from "../extensions/nexus/contract.ts";
import { reduce, type ThreadView } from "../extensions/nexus/thread.ts";
import { asked, detail, display, entries, ports, webPreview, fakeTui, keybindings, live, piTheme, plain, runningCall, working } from "./console-fixture.ts";
import { idA, idle } from "./fixtures.ts";

/** The note a second change of port 8080 gets while one runs, as every entry point says it. */
const busy = `Port 8080 on ${idA} is already being published or unpublished. Try again when it finishes.`;
const keys = { enter: "\r", escape: "\x1b", tab: "\t", right: "\x1b[C", down: "\x1b[B", up: "\x1b[A", pageUp: "\x1b[5~", pageDown: "\x1b[6~", ctrlO: "\x0f", ctrlD: "\x04", ctrlU: "\x15" };
const screens: ThreadScreen[] = [];
afterEach(() => screens.splice(0).forEach((s) => s.dispose()));

/** A preview the fake opens, or why it refuses to. */
type Opened = Preview | Error;

/** Port 8080 published on its own, beside the web service's preview. */
const own: Preview = { service: "port-8080", ready: true, url: "https://firebat.example.ts.net:8445/" };
const published: ThreadDetail = { ...detail, previews: [webPreview, own], ports: [ports[0]!, { port: 8080, service: null, preview: own }] };
/** A Claude Code session with a title, the fixture's pi session, and a shell from a control plane older than titles. */
const withSessions: ThreadDetail = {
	...detail,
	sessions: [
		{ id: "%5", state: "running", message: null, harness: "claude-code", herdrPane: "%5", status: "idle", harnessSessionId: "sid-1", title: "login fix" },
		detail.sessions[0]!,
		{ id: "%9", state: "running", message: null, harness: "shell", herdrPane: "%9", status: "unknown", harnessSessionId: null },
	],
};

function open(
	view: ThreadView = { entries, state: working, live },
	{
		rows = 60,
		sendFails = 0,
		opened = new Map<number, Opened>(),
		refused = new Map<number, Error>(),
		copyFails = false,
		shown = detail as ThreadDetail | null,
		session = { herdrPane: "%7", harness: "claude-code", title: "claude-code" } as OpenedSession | Error,
		attachFails = undefined as Error | undefined,
		closeFails = undefined as Error | undefined,
		cli = "nexus",
	} = {},
) {
	const sent: { text: string; steer: boolean; requestId: string }[] = [];
	const acted: Action[] = [];
	const previewed: number[] = [];
	const unpublished: number[] = [];
	const copied: string[] = [];
	const sessionsOpened: { harness: string; title: string | undefined }[] = [];
	const sessionsClosed: string[] = [];
	let attaches = 0;
	// Each preview waits for `release`, as `nexus preview --wait` waits for the node.
	let release = () => {};
	const ends: ScreenEnd[] = [];
	let failures = sendFails;
	let refreshes = 0;
	let rewatches = 0;
	const tui = fakeTui(rows, 100);
	let clock = asked + 72_000;
	const screen = new ThreadScreen({
		tui,
		theme: piTheme(),
		keybindings: keybindings(),
		display: display(),
		thread: idA,
		cli,
		checkout: { uncommitted: false, actions: {
			changes: async (head) => ({ base: { kind: head ? "head" : "start", commit: null }, files: [], truncated: false }),
			diff: async () => ({ base: { kind: "start", commit: null }, diff: "", truncated: false }),
			persist() {},
		} },
		now: () => clock,
		done: (end) => ends.push(end),
		actions: {
			async send(text, steer, requestId) {
				sent.push({ text, steer, requestId });
				if (failures-- > 0) throw new Error("Nexus is unreachable");
			},
			async act(action) {
				acted.push(action);
			},
			async preview(port) {
				previewed.push(port);
				await new Promise<void>((resolve) => (release = resolve));
				const result = opened.get(port) ?? new Error(`nexus: no preview for ${port}`);
				if (result instanceof Error) throw result;
				return result;
			},
			async unpublish(port) {
				unpublished.push(port);
				await new Promise<void>((resolve) => (release = resolve));
				const refusal = refused.get(port);
				if (refusal) throw refusal;
			},
			async openSession(harness, title) {
				sessionsOpened.push({ harness, title });
				await new Promise<void>((resolve) => (release = resolve));
				if (session instanceof Error) throw session;
				return session;
			},
			async closeSession(id) {
				sessionsClosed.push(id);
				await new Promise<void>((resolve) => (release = resolve));
				if (closeFails) throw closeFails;
			},
			async attach() {
				attaches++;
				if (attachFails) throw attachFails;
			},
			refresh() {
				refreshes++;
			},
			rewatch() {
				rewatches++;
			},
			async copy(text) {
				if (copyFails) throw new Error("no clipboard");
				copied.push(text);
			},
		},
	});
	screens.push(screen);
	screen.focused = true;
	screen.setView(view);
	if (shown !== null) screen.setDetail(shown, screen.mark());
	const text = () => plain(screen.render(100));
	/** The mode the hint line names. */
	const mode = () => (text().trimEnd().split("\n").at(-1)!.startsWith("INSERT") ? "insert" : "normal");
	/** Types `input` into the composer, from insert mode, and sends it. */
	const type = async (input: string) => {
		if (mode() === "normal") screen.handleInput("i");
		for (const ch of input) screen.handleInput(ch);
		screen.handleInput(keys.enter);
		await new Promise((resolve) => setTimeout(resolve, 0));
	};
	/** Presses `input` in normal mode, leaving insert mode first. */
	const normal = (...input: string[]) => {
		if (mode() === "insert") screen.handleInput(keys.escape);
		for (const k of input) screen.handleInput(k);
	};
	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
	/** Details as the console reads them, asked for now or at the earlier mark `askedAt`. */
	const details = (d: ThreadDetail, askedAt = screen.mark()) => screen.setDetail(d, askedAt);
	return { tick: (ms: number) => (clock += ms), screen, tui, sent, acted, previewed, unpublished, copied, sessionsOpened, sessionsClosed, attaches: () => attaches, ends, text, mode, type, normal, settle, details, refreshes: () => refreshes, rewatches: () => rewatches, release: () => release(), press: (...input: string[]) => input.forEach((k) => screen.handleInput(k)) };
}

describe("thread view", () => {
	test("draws the conversation with pi's components, the run in the editor's border and the footer", () => {
		const s = open();
		const out = s.text();
		expect(s.screen.render(100)).toHaveLength(60);
		expect(out).toContain("Fix the retry in probe.ts so it backs off.");
		expect(out).toContain("I'll read the probe first.");
		expect(out).toContain(" read src/probe.ts");
		expect(out).toContain("-2    await sleep(1000);");
		// The stored diff, with its line numbers, rather than one made from the arguments, and not the patch.
		expect(out).toContain("+2    await sleep(backoff(attempt));");
		expect(out).not.toContain("@@ -1,4 +1,4 @@");
		expect(out).toContain(" $ npm test\n");
		expect(out).toContain("Command exited with code 1");
		expect(out).toContain("$ npm test -- --bail");
		expect(out).toContain("✓ backs off");
		expect(out).toContain("Queued: also update the docs");
		expect(out).toMatch(/── \S Working · 1m 12s · 4 tools this turn · new messages queue ─+/);
		expect(out).toContain("nexus / Fix the probe retry ● agent working (th-0123456789ab)");
		expect(out).toMatch(/pylon running on firebat · seen 1 min ago · wanted running · 1 preview · 1 output +demo-model/);
	});

	test("a call whose result goes away is drawn afresh, without its old result or output", () => {
		const s = open();
		expect(s.text()).toContain("Command exited with code 1");
		// A reset whose entries no longer hold the failed run's result.
		s.screen.setView({ entries: entries.filter((_, i) => i !== 7), state: working, live });
		expect(s.text()).toContain(" $ npm test\n");
		expect(s.text()).not.toContain("Command exited with code 1");
		expect(s.text()).toContain("✓ backs off");
		// The live run no longer reports the running call.
		s.screen.setView({ entries, state: working, live: { ...live, tools: [] } });
		expect(s.text()).toContain("$ npm test -- --bail");
		expect(s.text()).not.toContain("✓ backs off");
	});

	test("a pending edit shows the diff of its arguments, as pi shows one", () => {
		const out = open({ entries: entries.slice(0, 5), state: working, live: { ...live, tools: [] } }).text();
		expect(out).toContain(" edit src/probe.ts");
		expect(out).toMatch(/-\s+await sleep\(1000\);/);
		expect(out).toMatch(/\+\s+await sleep\(backoff\(attempt\)\);/);
	});

	test("the hint line under the footer names the mode and the keys that work there, in pi's hint style", () => {
		const s = open();
		const hints = () => s.text().trimEnd().split("\n").at(-1)!;
		expect(s.text()).toMatch(/demo-model\nNORMAL {2}i write {2}j\/k scroll {2}d\/u half page {2}h\/l views {2}m actions {2}s keys {2}q close/);
		// pi's hint colours: the key dim, what it does muted.
		const t = piTheme();
		expect(s.screen.render(100).join("\n")).toContain(`${t.fg("dim", "i")}${t.fg("muted", " write")}`);
		s.normal("3");
		expect(hints()).toMatch(/^NORMAL {2}i write {2}j\/k select {2}enter publish {2}x unpublish {2}y copy {2}h\/l views/);
		s.press("i");
		expect(hints()).toBe("INSERT  esc normal mode  enter send  / commands  pgup/pgdn scroll  ctrl+o expand tools");
		s.press(":");
		expect(s.sent).toEqual([]);
		expect(hints()).toBe("INSERT  esc normal mode  enter send  / commands  pgup/pgdn scroll  ctrl+o expand tools");
	});

	test("the view opens in normal mode, where letters move it; i or a writes, Esc stops, and only insert mode shows the cursor", async () => {
		const s = open();
		const cursor = () => s.screen.render(100).some((l) => l.includes("\x1b_pi:fc"));
		expect(s.mode()).toBe("normal");
		expect(cursor()).toBe(false);
		s.press("l");
		expect(s.text()).toContain("Reading the changes…");
		s.press("l");
		expect(s.text()).toContain("Previews 1");
		s.press("l", "l");
		expect(s.text()).toContain("Attach from this Mac");
		s.press("h", "h", "h");
		expect(s.text()).toContain("I'll read the probe first.");
		s.press("i");
		expect(cursor()).toBe(true);
		// An empty Enter leaves insert mode, as Esc does.
		s.press(keys.enter);
		expect(s.mode()).toBe("normal");
		expect(s.sent).toEqual([]);
		s.press("a");
		expect(s.mode()).toBe("insert");
		for (const ch of "hjkl") s.press(ch);
		expect(s.text()).toMatch(/^hjkl/m);
		expect(s.text()).toContain("I'll read the probe first.");
		s.press(keys.escape);
		expect(s.mode()).toBe("normal");
		expect(cursor()).toBe(false);
		s.press("4");
		expect(s.text()).toContain("Pylon");
		// The draft waits in the composer while the view moves.
		expect(s.text()).toMatch(/^hjkl/m);
		s.press("a");
		s.press(keys.enter);
		await s.settle();
		expect(s.sent.map((m) => m.text)).toEqual(["hjkl"]);
		// Insert mode lasts past a send, so the next message needs no i.
		expect(s.mode()).toBe("insert");
	});

	test("/ in normal mode starts a slash command in the composer", async () => {
		const s = open();
		s.press("/");
		expect(s.mode()).toBe("insert");
		for (const ch of "abort") s.press(ch);
		s.press(keys.enter);
		await s.settle();
		expect(s.acted).toEqual(["abort"]);
	});

	test("a blank line sits above the editor, after the queued line or the transcript, as in pi", () => {
		const above = (view: ThreadView) => {
			const lines = open(view).text().split("\n");
			const border = lines.findIndex((l) => /^── \S Working/.test(l) || /^─{20}/.test(l));
			return lines.slice(border - 2, border);
		};
		expect(above({ entries, state: working, live })).toEqual([" Queued: also update the docs", ""]);
		expect(above({ entries, state: working, live: { ...live, queued: [] } })[1]).toBe("");
	});

	test("Enter sends the text, and a retry of the same text keeps its request ID", async () => {
		const s = open(undefined, { sendFails: 1 });
		await s.type("hello there");
		expect(s.sent).toEqual([{ text: "hello there", steer: false, requestId: expect.stringMatching(/^msg:/) }]);
		expect(s.text()).toContain("The message was not sent: Nexus is unreachable");
		// The failed text is back in the editor, so Enter sends it again.
		s.press(keys.enter);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(s.sent).toHaveLength(2);
		expect(s.sent[1]!.requestId).toBe(s.sent[0]!.requestId);
		await s.type("another");
		expect(s.sent[2]!.requestId).not.toBe(s.sent[0]!.requestId);
	});

	test("steering text first sent as a follow-up is a new message, with its own request ID", async () => {
		const s = open(undefined, { sendFails: 1 });
		await s.type("hello");
		s.press("\x03");
		await s.type("/steer hello");
		expect(s.sent.map((x) => x.steer)).toEqual([false, true]);
		expect(s.sent[1]!.requestId).not.toBe(s.sent[0]!.requestId);
	});

	test("a short terminal keeps the editor and footer, whatever piles up above them", async () => {
		const queued = Array.from({ length: 30 }, (_, i) => `follow-up ${i}`);
		const s = open({ entries, state: working, live: { ...live, queued }, outage: "Nexus is unreachable: no proxy." }, { rows: 12 });
		const lines = s.screen.render(100);
		expect(lines).toHaveLength(12);
		const out = plain(lines);
		expect(out).toContain("Working ·");
		expect(out).toContain("nexus / Fix the probe retry ● agent working (th-0123456789ab)");
		expect(out).toContain("Nexus is unreachable: no proxy. Still watching.");
		const tall = open({ entries, state: working, live: { ...live, queued } }).text();
		expect(tall).toContain("Queued: follow-up 2");
		expect(tall).not.toContain("Queued: follow-up 3");
		expect(tall).toContain("and 27 more queued");
	});

	test("a running call's output redraws when it changes, even at the same length", () => {
		const running = (output: string) => ({ entries, state: working, live: { ...live, tools: [{ callId: runningCall, output }] } });
		const s = open(running("status 10%"));
		expect(s.text()).toContain("status 10%");
		s.screen.setView(running("status 90%"));
		expect(s.text()).toContain("status 90%");
		expect(s.text()).not.toContain("status 10%");
	});

	test("slash commands run their action, /steer steers, and other slashes are messages", async () => {
		const s = open();
		await s.type("/abort");
		await s.type("/retry-pylon");
		expect(s.text()).toContain("Retried the pylon.");
		await s.type("/steer use the helper");
		await s.type("/tmp is full");
		expect(s.acted).toEqual(["abort", "retry-pylon"]);
		expect(s.sent.map(({ text, steer }) => ({ text, steer }))).toEqual([
			{ text: "use the helper", steer: true },
			{ text: "/tmp is full", steer: false },
		]);
	});

	test("/delete asks with Keep first, and only Delete deletes", async () => {
		const s = open();
		await s.type("/delete");
		expect(s.text()).toContain(`Delete ${idA}? Its pylon is deleted for good.`);
		expect(s.text()).toMatch(/→ Keep\n\s+Delete/);
		s.press(keys.enter);
		expect(s.acted).toEqual([]);
		expect(s.text()).toContain("Kept the thread.");
		await s.type("/delete");
		s.press(keys.escape);
		expect(s.acted).toEqual([]);
		expect(s.ends).toEqual([]);
		await s.type("/delete");
		s.press(keys.down);
		s.press(keys.enter);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(s.acted).toEqual(["delete"]);
	});

	test("h on the conversation goes back, q closes, t opens the picker, and Esc returns to the conversation but never closes or aborts", () => {
		const s = open();
		s.normal("4");
		expect(s.text()).toContain("Pylon");
		s.press(keys.escape);
		expect(s.text()).not.toContain("Desired");
		s.press(keys.escape);
		expect(s.ends).toEqual([]);
		s.press("h");
		s.press("q");
		s.press("t");
		expect(s.ends).toEqual([{ kind: "back" }, { kind: "close" }, { kind: "threads" }]);
		expect(s.acted).toEqual([]);
	});

	test("s or ? lists the keys over the view, and the next key only closes the list", () => {
		const s = open();
		s.press("s");
		expect(s.text()).toContain("Keys in normal mode");
		expect(s.text()).toMatch(/gg\/home +the top, or the first file, port or session/);
		expect(s.text()).toMatch(/ctrl\+o +expand or fold tool output, as in pi/);
		s.press("q");
		expect(s.ends).toEqual([]);
		expect(s.text()).not.toContain("Keys in normal mode");
	});

	test("m or : opens the actions that apply, j and k move, Enter runs one and Esc cancels", async () => {
		const s = open();
		s.press("m");
		const out = s.text();
		expect(out).toContain("Actions");
		expect(out).toMatch(/→ Abort the run/);
		for (const label of ["Start again", "Archive", "Copy the attach command", "Delete"]) expect(out).toContain(label);
		for (const label of ["Retry the parked tasks", "Retry the pylon", "Unarchive"]) expect(out).not.toContain(label);
		s.press(keys.escape);
		expect(s.text()).not.toContain("Abort the run");
		expect(s.acted).toEqual([]);
		s.press(":");
		s.press("j");
		s.press("j");
		s.press("k");
		s.press("j");
		s.press(keys.enter);
		await s.settle();
		expect(s.acted).toEqual(["archive"]);
		expect(s.text()).toContain("Archived the thread.");
		s.press(":");
		for (let i = 0; i < 3; i++) s.press("j");
		s.press(keys.enter);
		await s.settle();
		expect(s.copied).toEqual(["herdr --session nexus"]);
		const failed = open({ entries, state: { ...idle, run: "parked", parkedTasks: 1, pylon: "failed", failed: "boom", status: "archived" } });
		failed.press(":");
		expect(failed.text()).toMatch(/→ Retry the parked tasks.*\n.*Retry the pylon/);
		expect(failed.text()).toContain("Unarchive");
		expect(failed.text()).not.toMatch(/^ *(→ )?Archive /m);
	});

	test("when the watch ends the actions offer to watch again, which follows the thread again", () => {
		const s = open();
		s.screen.watchEnded("nexus: connection reset");
		expect(s.text()).toContain("The watch ended: nexus: connection reset. m, then Watch again, follows the thread again.");
		s.press("m");
		expect(s.text()).toMatch(/→ Watch again/);
		s.press(keys.enter);
		expect(s.rewatches()).toBe(1);
		expect(s.text()).toContain("Watching the thread again...");
		s.press("m");
		expect(s.text()).not.toContain("Watch again");
	});

	test("a deleted thread's ended watch keeps the delete's note and offers no watch again", async () => {
		const s = open();
		s.press("m", ..."jjjjjj", keys.enter, "j", keys.enter);
		await s.settle();
		expect(s.acted).toEqual(["delete"]);
		// The watch reports the thread deleted, then ends, as Nexus ends a deleted thread's watch.
		s.screen.setView({ entries, state: { ...idle, status: "deleted" } });
		s.screen.watchEnded(undefined);
		expect(s.text()).toContain("Deleted the thread.");
		expect(s.text()).not.toContain("The watch ended");
		s.press("m");
		expect(s.text()).not.toContain("Watch again");
	});

	test("y in Pylon copies the terminal attach command", async () => {
		const s = open();
		s.press("y");
		await s.settle();
		expect(s.copied).toEqual([]);
		s.press("4", "y");
		await s.settle();
		expect(s.copied).toEqual(["nexus attach th-0123456789ab"]);
	});

	test("Delete in the actions asks with Keep first, as /delete does", async () => {
		const s = open();
		s.press(":");
		s.press("G");
		for (let i = 0; i < 6; i++) s.press("j");
		s.press(keys.enter);
		expect(s.text()).toContain(`Delete ${idA}? Its pylon is deleted for good.`);
		s.press(keys.enter);
		expect(s.acted).toEqual([]);
		expect(s.text()).toContain("Kept the thread.");
		s.press(":");
		for (let i = 0; i < 6; i++) s.press("j");
		s.press(keys.enter);
		s.press("j");
		s.press(keys.enter);
		await s.settle();
		expect(s.acted).toEqual(["delete"]);
	});

	test("/start-again hands back the project and title", async () => {
		const s = open();
		await s.type("/start-again");
		expect(s.ends).toEqual([{ kind: "start-again", project: "nexus", title: "Fix the probe retry" }]);
	});

	test("Pylon shows the pylon, outputs, attach command and sessions; Previews shows previews and ports", () => {
		const s = open();
		s.screen.setNodes([{ name: "firebat", state: "offline" }]);
		s.normal("4");
		const details = s.text();
		expect(details).toMatch(/Desired +● running/);
		expect(details).toMatch(/Node +firebat offline/);
		expect(details).toMatch(/Last seen +1 min ago \(stale\)/);
		// The preview output repeats the listed preview, so only the branch is left.
		expect(details).toMatch(/Outputs 1\n +branch +nexus\/th-0123456789ab\n\n/);
		expect(details).toContain("%3");
		expect(details).toContain("herdr --session nexus");
		expect(details).not.toContain("https://firebat.example.ts.net");
		s.press("3");
		const out = s.text();
		expect(out).not.toContain("Desired");
		// The preview names its port, since the service is not port-5173, and links the URL the contract gives.
		expect(out).toContain("→ ● web  port 5173\n     https://firebat.example.ts.net:8443/");
		expect(s.screen.render(100).join("\n")).toContain("\x1b]8;;https://firebat.example.ts.net:8443/\x1b\\");
		expect(out).toContain("Click a link to open it, or copy it with y or /copy <port or service>.");
		// Each port shows once: 5173 under Previews, and 8080, which has no preview, under Ports.
		expect(out).toMatch(/Ports 1\n +● 8080  no preview yet\. \/open 8080 publishes one/);
		expect(out.match(/5173/g)).toHaveLength(1);
		expect(out).toContain("1 Conversation   2 Changes   3 Previews 1   4 Pylon");
	});

	test("in Ports, j and k select a row, Enter publishes a port, x unpublishes its own preview, and y copies a link", async () => {
		const s = open(undefined, { opened: new Map([[8080, own]]) });
		s.normal("3");
		s.press("y");
		await s.settle();
		expect(s.copied).toEqual([webPreview.url]);
		s.press(keys.enter);
		expect(s.text()).toContain("web is published already.");
		s.press("x");
		expect(s.text()).toContain("The service web keeps its preview");
		expect(s.previewed).toEqual([]);
		s.press("j");
		expect(s.text()).toMatch(/→ ● 8080  no preview yet\. enter or \/open 8080 publishes one/);
		s.press(keys.enter);
		expect(s.previewed).toEqual([8080]);
		expect(s.text()).toContain("● 8080  opening:");
		s.press("o");
		expect(s.previewed).toEqual([8080]);
		expect(s.text().replace(/\s+/g, " ")).toContain(busy);
		s.release();
		await s.settle();
		// The published port is a preview row now, after web's.
		s.press("G");
		expect(s.text()).toMatch(/→ ● port-8080\n +https:\/\/firebat\.example\.ts\.net:8445\/\n +x or \/unpublish 8080 closes it\n/);
		s.press(keys.enter);
		expect(s.text()).toContain("port-8080 is published already. x unpublishes it.");
		expect(s.unpublished).toEqual([]);
		s.press("x");
		expect(s.unpublished).toEqual([8080]);
		s.release();
		await s.settle();
		expect(s.text()).toMatch(/Ports 1\n +→ ● 8080  no preview yet/);
		s.press("g");
		s.press("g");
		s.press("k");
		expect(s.text()).toMatch(/→ ● web/);
	});

	test("Sessions lists each session with its title, selects with j and k, and says how to attach from this Mac", () => {
		const s = open(undefined, { shown: withSessions });
		s.normal("4");
		const out = s.text();
		expect(out).toContain("1 Conversation   2 Changes   3 Previews 1   4 Pylon");
		expect(out).toMatch(/Sessions 3\n → Claude Code  login fix  ● idle  %5  session sid-1\n     enter or \/attach attaches this terminal, x closes the session\n +pi +● working  %3  session abc\n +Shell +● unknown  %9\n/);
		expect(out).toContain("Attach from this Mac\n   nexus attach th-0123456789ab\n   enter runs it here, and y copies it.");
		expect(out).toContain('set "ssh": {"<node>": "<user@host or alias>"} in ~/.config/nexus/cli.json');
		expect(out).toMatch(/NORMAL  i write  j\/k select  enter attach  x close  n open  y copy/);
		s.press("j");
		expect(s.text()).toMatch(/→ pi +● working  %3  session abc\n     enter or \/attach/);
		s.press("G");
		expect(s.text()).toMatch(/→ Shell/);
		const none = open(undefined, { shown: { ...detail, sessions: [] } });
		none.normal("4");
		expect(none.text()).toContain("No sessions. n opens one: Claude Code, pi or a shell.");
	});

	test("Sessions shows and y copies the attach command through the configured CLI, quoted for a shell", async () => {
		const s = open(undefined, { shown: withSessions, cli: "/opt/nexus tools/nexus" });
		s.normal("4");
		expect(s.text()).toContain("Attach from this Mac\n   '/opt/nexus tools/nexus' attach th-0123456789ab\n");
		s.press("y");
		await s.settle();
		expect(s.copied).toEqual(["'/opt/nexus tools/nexus' attach th-0123456789ab"]);
	});

	test("n opens the session form on Claude Code, ←→ choose the harness, and Enter opens it, opening, then opened", async () => {
		const s = open(undefined, { shown: withSessions });
		s.normal("n");
		expect(s.text()).toContain(" Open a session in the pylon\n → Harness  [Claude Code]  pi   Shell\n   Title    > optional; claude-code when empty");
		expect(s.text()).toMatch(/NORMAL  tab next field  ←→ harness  enter open  esc cancel/);
		s.press(keys.escape);
		expect(s.text()).not.toContain("Open a session in the pylon");
		s.press("n", keys.right);
		expect(s.text()).toContain("→ Harness   Claude Code  [pi]  Shell");
		s.press(keys.tab, ..."review", keys.enter);
		expect(s.sessionsOpened).toEqual([{ harness: "pi", title: "review" }]);
		// The view goes to Sessions, where the open shows until the CLI answers.
		expect(s.text()).toMatch(/● Opening pi "review"\.\.\.\n     Waking the pylon if it is paused, then starting the agent, which can take a minute\./);
		expect(s.text()).toContain('Opening pi "review". Its agent can take a minute to start.');
		const refreshes = s.refreshes();
		s.release();
		await s.settle();
		expect(s.text()).not.toContain("Opening pi");
		expect(s.text()).toMatch(/Claude Code  claude-code  ● opened  %7/);
		expect(s.text().replace(/\s+/g, " ")).toContain('Opened Claude Code "claude-code" in pane %7. Enter in Pylon, or /attach, attaches this terminal: pick the session\'s workspace in Herdr.');
		expect(s.refreshes()).toBe(refreshes + 1);
		// Details asked for after the open are the sessions as they are.
		s.details({ ...withSessions, sessions: [...withSessions.sessions, { id: "%7", state: "running", message: null, harness: "claude-code", herdrPane: "%7", status: "blocked", harnessSessionId: "sid-7", title: "claude-code" }] });
		expect(s.text()).toMatch(/Claude Code  claude-code  ● blocked  %7  session sid-7/);
		// Enter on the harness opens Claude Code with the CLI's default title.
		s.press("n", keys.enter);
		expect(s.sessionsOpened.at(-1)).toEqual({ harness: "claude-code", title: undefined });
		s.release();
		await s.settle();
	});

	test("a session just opened or closed stays so until the details show it, or for half a minute", async () => {
		const s = open(undefined, { shown: withSessions });
		s.normal("n", keys.enter);
		s.release();
		await s.settle();
		// Details read before the node saw the new session still list only the old ones.
		s.details(withSessions);
		expect(s.text()).toMatch(/Claude Code  claude-code  ● opened  %7/);
		s.press("G", "x", "j", keys.enter);
		expect(s.sessionsClosed).toEqual(["%7"]);
		s.release();
		await s.settle();
		// Closing the session just opened forgets it, whatever the details say next.
		s.details(withSessions);
		expect(s.text()).not.toContain("● opened");
		s.press("g", "g", "x", "j", keys.enter);
		s.release();
		await s.settle();
		s.details(withSessions);
		expect(s.text()).not.toMatch(/login fix/);
		expect(s.text()).toContain("Sessions 2");
		// Details that never stop listing it win once the half minute is up.
		s.tick(30_000);
		s.details(withSessions);
		expect(s.text()).toMatch(/login fix/);
		s.press("n", keys.enter);
		s.release();
		await s.settle();
		s.tick(30_000);
		s.details(withSessions);
		expect(s.text()).not.toContain("● opened");
	});

	test("a session that does not open says why, in the CLI's words", async () => {
		const tooOld = "nexus has no session open command: opening a session needs Nexus CLI 0.5.0 or later (nexus --version)";
		const s = open(undefined, { session: new Error(tooOld) });
		await s.type("/session");
		expect(s.text()).toContain("Open a session in the pylon");
		s.press(keys.enter);
		s.release();
		await s.settle();
		expect(s.text().replace(/\s+/g, " ")).toContain(`The session did not open: ${tooOld}`);
		expect(s.text()).toMatch(/Sessions 1\n → pi +● working/);
	});

	test("x in Sessions asks with Keep first, and Close closes the selected session", async () => {
		const s = open(undefined, { shown: withSessions });
		s.normal("4", "j", "x");
		expect(s.text()).toContain("Close pi in pane %3? Its agent ends.\n→ Keep\n  Close");
		s.press(keys.enter);
		expect(s.text()).toContain("Kept the session.");
		expect(s.sessionsClosed).toEqual([]);
		s.press("x", "j", keys.enter);
		expect(s.sessionsClosed).toEqual(["%3"]);
		expect(s.text()).toMatch(/→ pi +● closing\.\.\.  %3/);
		s.press("x");
		expect(s.text()).toContain("Pane %3 is already closing.");
		s.release();
		await s.settle();
		expect(s.text()).toContain("Closed pane %3.");
		expect(s.text()).not.toMatch(/pi +● /);
		expect(s.text()).toContain("Sessions 2");
	});

	test("a paused session reads as resuming on wake, or on unarchive, and x does not close it", () => {
		const paused: Session = { id: "w1:p1", state: "paused", message: null, harness: "claude-code", herdrPane: "w1:p1", status: "working", harnessSessionId: "bd2c2d6b", title: "review" };
		const s = open(undefined, { shown: { ...detail, sessions: [paused, detail.sessions[0]!] } });
		s.normal("4");
		expect(s.text()).toMatch(/Sessions 2\n → Claude Code  review  ● paused, resumes on wake  w1:p1  session bd2c2d6b\n     enter or \/attach wakes the pylon and attaches this terminal\. It can be closed once it runs\n +pi +● working  %3/);
		s.press("x");
		expect(s.text()).not.toContain("Keep");
		expect(s.text()).toContain('Claude Code "review" is paused with the pylon and resumes on wake. Close it once it runs.');
		expect(s.sessionsClosed).toEqual([]);
		const archived = open(undefined, { shown: { ...detail, thread: { ...detail.thread, status: "archived" }, sessions: [paused] } });
		archived.normal("4");
		expect(archived.text()).toMatch(/● paused, resumes on unarchive  w1:p1  session bd2c2d6b\n     \/unarchive brings it back, and it can be closed once it runs/);
		archived.press("x");
		expect(archived.text()).toContain('Claude Code "review" is paused with the pylon and resumes on unarchive. Close it once it runs.');
		expect(archived.sessionsClosed).toEqual([]);
	});

	test("a failed session shows why, whole when selected, and x closes it by its ID, so no wake tries it again", async () => {
		const failed: Session = {
			id: "failed-0123456789ab",
			state: "failed",
			message: "herdr agent start: the agent did not start.\nThe pane showed:\npi: command not found",
			harness: "pi",
			herdrPane: null,
			status: "unknown",
			harnessSessionId: "/s.jsonl",
			title: "plan",
		};
		const s = open(undefined, { shown: { ...detail, sessions: [detail.sessions[0]!, failed] } });
		s.normal("4");
		// Not selected, it shows its message's first line, with the ID that closes it where a pane would be.
		expect(s.text()).toMatch(/ +pi +plan  ● failed  failed-0123456789ab  session \/s\.jsonl\n +herdr agent start: the agent did not start\.\n\n Attach/);
		s.press("j");
		expect(s.text()).toMatch(/→ pi +plan  ● failed  failed-0123456789ab  session \/s\.jsonl\n +herdr agent start: the agent did not start\.\n +The pane showed:\n +pi: command not found\n +enter or \/attach attaches this terminal, x closes the session so that no wake tries it again/);
		s.press("x");
		expect(s.text()).toContain('Close pi "plan", which the last wake did not bring back? No wake tries it again.\n→ Keep\n  Close');
		s.press("j", keys.enter);
		expect(s.sessionsClosed).toEqual(["failed-0123456789ab"]);
		expect(s.text()).toMatch(/→ pi +plan  ● closing\.\.\.  failed-0123456789ab/);
		expect(s.text()).toContain("Closing session failed-0123456789ab...");
		s.release();
		await s.settle();
		expect(s.text()).toContain("Closed session failed-0123456789ab.");
		expect(s.text()).toContain("4 Pylon");
		expect(s.text()).toContain("Sessions 1");
	});

	test("a close the CLI refuses says why in its words, keeps the session and reads the sessions again", async () => {
		const moved = "no session is open in pane %3 of pylon py-0123. A wake may have moved it to another pane, which the thread's sessions list";
		const s = open(undefined, { shown: withSessions, closeFails: new Error(moved) });
		s.normal("4", "j", "x", "j", keys.enter);
		const refreshes = s.refreshes();
		s.release();
		await s.settle();
		expect(s.sessionsClosed).toEqual(["%3"]);
		expect(s.text().replace(/\s+/g, " ")).toContain(`Pane %3 was not closed: ${moved}`);
		expect(s.text()).toMatch(/→ pi +● working  %3/);
		expect(s.refreshes()).toBe(refreshes + 1);
	});

	test("a session closed in a pane that a later session takes shows that session, and one a wake moved stays closed", async () => {
		const s = open(undefined, { shown: withSessions });
		s.normal("4", "j", "x", "j", keys.enter);
		s.release();
		await s.settle();
		// The details still list the closed pi session, but in the pane a wake gave it: it stays gone.
		const moved = { ...detail.sessions[0]!, id: "%8", herdrPane: "%8" };
		s.details({ ...withSessions, sessions: [withSessions.sessions[0]!, moved] });
		expect(s.text()).not.toMatch(/pi +● /);
		// A later shell in pane %3 is another session, which shows.
		const later: Session = { id: "%3", state: "running", message: null, harness: "shell", herdrPane: "%3", status: "unknown", harnessSessionId: null, title: "scratch" };
		s.details({ ...withSessions, sessions: [withSessions.sessions[0]!, later] });
		expect(s.text()).toMatch(/Shell +scratch  ● unknown  %3/);
	});

	test("a later session in a closed session's pane with its harness and title, but another harness session, shows at once", async () => {
		const s = open(undefined, { shown: withSessions });
		s.normal("4", "x", "j", keys.enter);
		s.release();
		await s.settle();
		expect(s.sessionsClosed).toEqual(["%5"]);
		expect(s.text()).not.toMatch(/login fix/);
		const later: Session = { ...withSessions.sessions[0]!, harnessSessionId: "sid-9" } as Session;
		s.details({ ...withSessions, sessions: [later, ...withSessions.sessions.slice(1)] });
		expect(s.text()).toMatch(/Claude Code  login fix  ● idle  %5  session sid-9/);
	});

	test("a session just opened settles once listed, even after a wake moves it and the pylon's other session", async () => {
		const s = open(undefined, { shown: withSessions });
		s.normal("n", keys.enter);
		s.release();
		await s.settle();
		expect(s.text()).toMatch(/Claude Code  claude-code  ● opened  %7/);
		// A wake put the existing pi session in %7 and the new one in %8: the new one shows once, the pi session too.
		const movedPi = { ...detail.sessions[0]!, id: "%7", herdrPane: "%7" };
		const fresh: Session = { id: "%8", state: "running", message: null, harness: "claude-code", herdrPane: "%8", status: "blocked", harnessSessionId: "sid-8", title: "claude-code" };
		s.details({ ...withSessions, sessions: [withSessions.sessions[0]!, movedPi, withSessions.sessions[2]!, fresh] });
		expect(s.text()).not.toContain("● opened");
		expect(s.text()).toMatch(/pi +● working  %7  session abc/);
		expect(s.text()).toMatch(/Claude Code  claude-code  ● blocked  %8  session sid-8/);
		expect(s.text()).toContain("4 Pylon");
		expect(s.text()).toContain("Sessions 4");
	});

	test("a session just opened keeps its row while stale details list only the sessions there before, even in its pane", async () => {
		// Before the open, pane %7 held another session of the same harness and title, which the open's pane now names.
		const earlier: Session = { id: "%7", state: "running", message: null, harness: "claude-code", herdrPane: "%7", status: "idle", harnessSessionId: "sid-old", title: "claude-code" };
		const s = open(undefined, { shown: { ...withSessions, sessions: [...withSessions.sessions, earlier] } });
		s.normal("n", keys.enter);
		s.release();
		await s.settle();
		s.details({ ...withSessions, sessions: [...withSessions.sessions, earlier] });
		expect(s.text()).toMatch(/Claude Code  claude-code  ● opened  %7/);
		s.tick(30_000);
		s.details({ ...withSessions, sessions: [...withSessions.sessions, earlier] });
		expect(s.text()).not.toContain("● opened");
	});

	test("Enter in Sessions, /attach and Attach in the actions attach this terminal, and say how it ended", async () => {
		const s = open(undefined, { shown: withSessions });
		s.normal("m");
		expect(s.text()).toMatch(/Copy the attach command.*\n.*Open a session.*\n.*Attach .*this terminal to the pylon's sessions/);
		s.press(keys.escape, "4", keys.enter);
		await s.settle();
		expect(s.attaches()).toBe(1);
		expect(s.text()).toContain("Detached from the pylon's sessions.");
		await s.type("/attach");
		expect(s.attaches()).toBe(2);
		s.normal("y");
		await s.settle();
		expect(s.copied).toEqual(["nexus attach th-0123456789ab"]);
		const why = 'attaching to th-0123456789ab on firebat failed: ssh to firebat.example exited 255. To reach the node as another user or through an ssh alias, set "ssh": {"firebat": "<user@host or alias>"} in ~/.config/nexus/cli.json, or set NEXUS_ATTACH, as docs/cli.md describes';
		const failed = open(undefined, { attachFails: new Error(why) });
		failed.normal("m", ..."jjjjj", keys.enter);
		await failed.settle();
		expect(failed.attaches()).toBe(1);
		expect(failed.text().replace(/\s+/g, " ")).toContain(`Attaching failed: ${why}`);
		const archived = open({ entries, state: { ...idle, status: "archived" } });
		archived.press("m");
		expect(archived.text()).not.toContain("Open a session");
		expect(archived.text()).not.toMatch(/^ *(→ )?Attach /m);
	});

	test("a selected port far down the Ports view scrolls into sight", () => {
		const many = Array.from({ length: 30 }, (_, i) => ({ port: 3000 + i, service: null, preview: null }));
		const s = open(undefined, { rows: 20, shown: { ...detail, ports: many } });
		s.normal("3");
		s.press("G");
		expect(s.text()).toMatch(/→ ● 3029/);
		s.press("g");
		s.press("g");
		expect(s.text()).toMatch(/→ ● web/);
	});

	test("a preview whose service failed shows failed in red, with why and no link", () => {
		const why = "the service web failed. `nexus service logs web` in the pylon shows why";
		const failed = { ...webPreview, ready: false, failed: why };
		const s = open();
		s.details({ ...detail, previews: [failed], ports: [{ port: 5173, service: "web", preview: failed }, ports[1]!] });
		s.normal("3");
		const out = plain(s.screen.render(60));
		expect(out).toContain(
			"Previews 1\n → ● web failed  port 5173\n     https://firebat.example.ts.net:8443/\n     the service web failed. `nexus service logs web` in\n     the pylon shows why\n",
		);
		const raw = s.screen.render(60).join("\n");
		expect(raw).toContain(piTheme().fg("error", " failed"));
		expect(raw).not.toContain("\x1b]8;;https://firebat.example.ts.net:8443/");
		expect(out).not.toContain("Click a link");
	});

	test("the ports section says why it lists nothing, and names a service's port", () => {
		const inspect = (d: ThreadDetail) => {
			const s = open();
			s.details(d);
			s.normal("3");
			// Wide enough that the hint does not wrap.
			return plain(s.screen.render(160));
		};
		const none = inspect({ ...detail, ports: [] });
		expect(none).toContain("Nothing listens yet. A server bound only to ::1 can't be previewed, so bind it to 0.0.0.0 or 127.0.0.1.");
		expect(inspect({ ...detail, ports: ports.slice(0, 1) })).toContain("Every port that listens is under Previews. A server bound only to ::1");
		expect(inspect({ ...detail, ports: null })).toContain("The pylon's ports could not be read.");
		expect(inspect({ ...detail, pylon: { ...detail.pylon, actualState: "paused" }, ports: [] })).toContain("Ports show while the pylon runs.");
		const owned = inspect({ ...detail, ports: [...ports, { port: 9000, service: "api", preview: null }] });
		expect(owned).toContain("● 9000  api, a service with no preview");
		expect(owned).not.toContain("/open 9000");
		// A preview of a port with no service of its own is named after the port, so it shows no port label.
		const own = { service: "port-3000", ready: true, url: "https://firebat.example.ts.net:8444/" };
		expect(inspect({ ...detail, previews: [own], ports: [{ port: 3000, service: null, preview: own }] })).toMatch(/● port-3000\n/);
	});

	test("/open publishes a port, shows it opening, then lists it under Previews", async () => {
		const s = open(undefined, { opened: new Map([[8080, own]]) });
		s.normal("3");
		await s.type("/open 8080");
		expect(s.previewed).toEqual([8080]);
		expect(s.text()).toContain("● 8080  opening: publishing it and waiting for the node to serve its URL...");
		await s.type("/open 8080");
		expect(s.previewed).toEqual([8080]);
		expect(s.text().replace(/\s+/g, " ")).toContain(busy);
		s.release();
		await s.settle();
		expect(s.text()).toMatch(/Previews 2\n.*\n.*\n +● port-8080\n +https:\/\/firebat\.example\.ts\.net:8445\/\n +\/unpublish 8080 closes it\n/);
		expect(s.text()).toMatch(/Ports 0\n/);
		expect(s.text()).toContain("Port 8080 is open at https://firebat.example.ts.net:8445/");
		await s.type("/copy 8080");
		expect(s.copied).toEqual([own.url]);
	});

	test("/open says why a port did not open, and tries again", async () => {
		const opened = new Map<number, Opened>([[8080, new Error("nexus: the pylon is not running (exit 5)")]]);
		const s = open(undefined, { opened });
		s.normal("3");
		await s.type("/open 8080");
		s.release();
		await s.settle();
		// The port's row says why, as well as the note above the editor.
		expect(s.text()).toMatch(/● 8080 {2}did not open\. \/open 8080 tries again\n {3}nexus: the pylon is not running \(exit 5\)\n/);
		opened.set(8080, own);
		await s.type("/open 8080");
		s.release();
		await s.settle();
		expect(s.previewed).toEqual([8080, 8080]);
		expect(s.text()).toMatch(/● port-8080\n +https:\/\/firebat\.example\.ts\.net:8445\/\n/);
		expect(s.text()).not.toContain("did not open");
		await s.type("/open http");
		expect(s.text()).toContain("/open needs a port number, such as /open 8080.");
		expect(s.previewed).toHaveLength(2);
	});

	test("/unpublish shows the preview closing, then the port back under Ports before the details are read again", async () => {
		const s = open(undefined, { shown: published });
		s.normal("3");
		expect(s.text()).toMatch(/● port-8080\n +https:\/\/firebat\.example\.ts\.net:8445\/\n +\/unpublish 8080 closes it\n/);
		await s.type("/unpublish 8080");
		expect(s.unpublished).toEqual([8080]);
		expect(s.text()).toMatch(/● port-8080 closing\.\.\.\n.*\n +Unpublishing it\. A paused pylon wakes first, which can take a while\./);
		await s.type("/unpublish 8080");
		await s.type("/open 8080");
		expect(s.unpublished).toEqual([8080]);
		expect(s.previewed).toEqual([]);
		expect(s.text().replace(/\s+/g, " ")).toContain(busy);
		s.release();
		await s.settle();
		expect(s.text()).not.toContain("port-8080");
		expect(s.text()).toMatch(/Ports 1\n +● 8080  no preview yet\. \/open 8080 publishes one/);
		expect(s.text()).toContain("Port 8080 is unpublished. /open 8080 publishes it again, maybe at a new URL.");
		expect(s.text()).toMatch(/· 1 preview ·/);
	});

	test("an unpublished port stays under Ports until details asked for after it, whatever an older read or a failed /open says", async () => {
		const s = open(undefined, { shown: published, opened: new Map([[8080, new Error("nexus: the pylon is not running (exit 5)")]]) });
		s.normal("3");
		const before = s.screen.mark();
		await s.type("/unpublish 8080");
		s.release();
		await s.settle();
		// Details asked for before the unpublish ended still list the preview.
		s.details(published, before);
		expect(s.text()).not.toContain("port-8080");
		await s.type("/copy 8080");
		expect(s.text()).toContain("No preview has the port or service 8080.");
		await s.type("/open 8080");
		s.release();
		await s.settle();
		expect(s.text()).toMatch(/Ports 1\n +● 8080 {2}did not open\. \/open 8080 tries again\n {3}nexus: the pylon is not running \(exit 5\)\n/);
		expect(s.text()).not.toContain(own.url);
		// Details asked for after it show the port as it is, published again by someone else.
		s.details(published);
		expect(s.text()).toMatch(/● port-8080\n/);
	});

	test("a port opened here and unpublished elsewhere before the next details shows under Ports, and /copy forgets it", async () => {
		const s = open(undefined, { opened: new Map([[8080, own]]) });
		s.normal("3");
		await s.type("/open 8080");
		s.release();
		await s.settle();
		expect(s.text()).toMatch(/● port-8080\n/);
		s.details(detail);
		expect(s.text()).toMatch(/Ports 1\n +● 8080  no preview yet\. \/open 8080 publishes one\n\n/);
		expect(s.text()).not.toContain("port-8080");
		await s.type("/copy 8080");
		expect(s.copied).toEqual([]);
		expect(s.text()).toContain("No preview has the port or service 8080.");
	});

	test("a port opened before the first details have loaded can be copied", async () => {
		const s = open(undefined, { shown: null, opened: new Map([[8080, own]]) });
		await s.type("/open 8080");
		s.release();
		await s.settle();
		await s.type("/copy 8080");
		expect(s.copied).toEqual([own.url]);
	});

	test("/unpublish says why a preview did not close, and only a port's own preview offers it", async () => {
		const refusal = "nexus: port 5173 is previewed by the service web, which keeps its preview";
		const refused = new Map([[5173, new Error(refusal)], [8080, new Error("nexus: the node firebat is unreachable")]]);
		const s = open(undefined, { shown: published, refused });
		s.normal("3");
		expect(s.text()).not.toContain("/unpublish 5173");
		await s.type("/unpublish 8080");
		s.release();
		await s.settle();
		expect(s.text()).toMatch(/● port-8080\n.*\n +did not close\. \/unpublish 8080 tries again\n {5}nexus: the node firebat is unreachable\n/);
		await s.type("/unpublish 5173");
		s.release();
		await s.settle();
		expect(s.text()).toMatch(/● web  port 5173\n.*\n {5}did not close\.\n {5}nexus: port 5173 is previewed by the service web/);
		await s.type("/unpublish 0");
		expect(s.text()).toContain("/unpublish needs a port number, such as /unpublish 8080.");
		expect(s.unpublished).toEqual([8080, 5173]);
		const archived = open(undefined, { shown: { ...published, thread: { ...published.thread, status: "archived" } } });
		archived.normal("3");
		expect(archived.text()).toContain("● port-8080 paused");
		expect(archived.text()).not.toContain("/unpublish");
	});

	test("a preview whose /open is still waiting offers no /unpublish", async () => {
		const starting = { ...own, ready: false };
		const s = open(undefined, { opened: new Map([[8080, own]]) });
		s.normal("3");
		await s.type("/open 8080");
		// The details list the preview, still starting, while the CLI waits for the node.
		s.details({ ...detail, previews: [webPreview, starting], ports: [ports[0]!, { port: 8080, service: null, preview: starting }] });
		expect(s.text()).toMatch(/● port-8080 starting\n/);
		expect(s.text()).not.toContain("/unpublish 8080");
		s.release();
		await s.settle();
		expect(s.text()).toContain("/unpublish 8080 closes it");
	});

	test("/copy copies a preview's link by its port or its service, and says when it cannot", async () => {
		const s = open();
		await s.type("/copy 5173");
		await s.type("/copy web");
		expect(s.copied).toEqual([webPreview.url, webPreview.url]);
		expect(s.text()).toContain(`Copied ${webPreview.url}`);
		await s.type("/copy 8080");
		expect(s.text()).toContain("No preview has the port or service 8080.");
		const broken = open(undefined, { copyFails: true });
		await broken.type("/copy web");
		expect(broken.text()).toContain("The link was not copied: no clipboard");
	});

	test("an archived thread refuses messages, and a failed pylon says what to do", async () => {
		const archived = open({ entries, state: { ...idle, status: "archived" } });
		await archived.type("hi");
		expect(archived.sent).toEqual([]);
		expect(archived.text()).toContain("An archived thread takes no messages, because its pylon stays paused. /unarchive to send one.");
		// The refused text stays in the editor until ctrl+c clears it, as in pi.
		archived.press("\x03");
		await archived.type("/unarchive");
		expect(archived.acted).toEqual(["unarchive"]);

		const failed = open({ entries, state: { ...idle, pylon: "failed", failed: "git clone: permission denied" } });
		const out = failed.text();
		expect(out).toContain("The planner gave up on this thread's pylon");
		expect(out).toContain("git clone: permission denied");
		await failed.type("hi");
		expect(failed.sent).toEqual([]);
	});

	test("a parked run says how to retry it, and a paused pylon that a message wakes it", () => {
		expect(open({ entries, state: { ...idle, run: "parked", parkedTasks: 2 } }).text()).toContain("⚠ 2 tasks hit the restart limit and hold the run. /retry runs them again.");
		expect(open({ entries, state: { ...idle, pylon: "paused" } }).text()).toContain("The pylon is paused. Sending a message wakes it.");
	});

	test("a retried model request shows in the border instead of the working line", () => {
		const out = open({ entries, state: working, live: { ...live, retry: "overloaded" } }).text();
		expect(out).toContain("The model request failed and will be retried: overloaded");
		expect(out).not.toContain("Working ·");
	});

	test("an outage shows until the watch reports the thread again", () => {
		const view: ThreadView = { entries, state: working, live };
		const s = open(view);
		const down = reduce(view, { type: "error", thread: idA, kind: "unreachable", message: "no proxy" });
		s.screen.setView(down);
		expect(s.text()).toContain("Nexus is unreachable: no proxy. Still watching.");
		s.screen.setView(reduce(down, { type: "state", thread: idA, ...working }));
		expect(s.text()).not.toContain("Still watching.");
		expect(s.text()).not.toContain("unreachable");
	});

	test("PgUp scrolls back and PgDn returns to the end, which then follows", () => {
		const s = open(undefined, { rows: 20 });
		const end = s.text();
		s.press(keys.pageUp);
		expect(s.text()).toMatch(/↓ \d+ more lines, G follows the end/);
		s.press(keys.pageDown);
		s.press(keys.pageDown);
		expect(s.text()).toBe(end);
	});

	test("keys a terminal sends as xterm modifyOtherKeys sequences type as they do in pi's editor", () => {
		const s = open(undefined, { rows: 20 });
		const end = s.text();
		s.press("k");
		expect(s.text()).not.toBe(end);
		// G with Shift, as ESC[27;2;71~, follows the end again.
		s.press("\x1b[27;2;71~");
		expect(s.text()).toBe(end);
		// g twice, unmodified, goes to the top.
		s.press("\x1b[27;1;103~", "\x1b[27;1;103~");
		expect(s.text()).toContain("Fix the retry in probe.ts so it backs off.");
		// ctrl+g types nothing, so g, ctrl+g, g is not gg.
		s.press("\x1b[27;2;71~", "\x1b[27;1;103~", "\x1b[27;5;103~", "g");
		expect(s.text()).not.toContain("Fix the retry in probe.ts so it backs off.");
		expect(s.text()).toMatch(/\nNORMAL {2}g {2}/);
	});

	test("vim's keys scroll: k and j a line, u and d or ctrl+u and ctrl+d half a page, gg the top and G or ge back to following", () => {
		const s = open(undefined, { rows: 20 });
		const end = s.text();
		const more = () => Number(/↓ (\d+) more line/.exec(s.text())?.[1] ?? 0);
		s.press("k");
		expect(more()).toBe(1);
		s.press(keys.ctrlU);
		const half = more() - 1;
		expect(half).toBeGreaterThan(1);
		s.press(keys.ctrlD);
		s.press("j");
		expect(s.text()).toBe(end);
		s.press("u");
		expect(more()).toBe(half);
		s.press("d");
		expect(s.text()).toBe(end);
		s.press("g");
		s.press("g");
		expect(s.text()).toContain("Fix the retry in probe.ts so it backs off.");
		s.press("g", "e");
		expect(s.text()).toBe(end);
		s.press("g", "g");
		// A g waiting for its pair shows beside the mode.
		s.press("g");
		expect(s.text()).toMatch(/\nNORMAL {2}g {2}/);
		s.press("G");
		expect(s.text()).toBe(end);
		s.screen.setView({ entries, state: working, live: { ...live, tools: [{ callId: runningCall, output: "more output" }] } });
		expect(s.text()).toContain("more output");
	});
});

describe("folds of steps", () => {
	const bash = (id: number, extra: Partial<ToolResultMessage> = {}): RenderedEntry[] => [
		{ entry: { id, model: [{ role: "assistant", model: "demo-model", stopReason: "toolUse", content: [{ type: "toolCall", id: `s${id}`, name: "bash", arguments: { command: `make step${id}` } }] }] }, text: "" },
		{ entry: { id: id + 100, model: [{ role: "toolResult", toolCallId: `s${id}`, toolName: "bash", content: [{ type: "text", text: `out ${id}` }], isError: false, ...extra }] }, text: "" },
	];
	const steps = [entries[1]!, ...bash(1), ...bash(2), ...bash(3), ...bash(4)];

	test("four steps fold into one line that ctrl+o opens", () => {
		const s = open({ entries: steps, state: idle });
		expect(s.text()).toContain("▸ 4 steps · ran make step1, ran make step2, ran make step3, ran make step4");
		expect(s.text()).not.toContain("$ make step1");
		s.press(keys.ctrlO);
		expect(s.text()).toContain("▾ 4 steps");
		expect(s.text()).toContain("$ make step1");
	});

	test("a fold with a failed step opens by itself and names its exit code", () => {
		const failing = [entries[1]!, ...bash(1), ...bash(2), ...bash(3), ...bash(4, { isError: true, content: [{ type: "text", text: "Command exited with code 2" }] })];
		const out = open({ entries: failing, state: idle }).text();
		expect(out).toContain("▾ 4 steps · ran make step1, ran make step2, ran make step3, ran make step4 · 1 failed, exit 2");
		expect(out).toContain("$ make step4");
	});
});

test("the console draws with theme colours only", () => {
	const dir = path.join(import.meta.dir, "../extensions/nexus/console");
	for (const file of readdirSync(dir)) {
		const source = readFileSync(path.join(dir, file), "utf8");
		expect(source).not.toMatch(/\\x1b|\\u001b|\\e\[|#[0-9a-fA-F]{6}\b|rgb\(/);
	}
});
