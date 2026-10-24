import { describe, expect, test } from "bun:test";
import { Picker, type PickerEnd } from "../extensions/nexus/console/picker.ts";
import { StartFormView } from "../extensions/nexus/console/start-form.ts";
import type { StartForm } from "../extensions/nexus/console/model.ts";
import { asked, fakeTui, keybindings, piTheme, plain } from "./console-fixture.ts";
import { idA, idB, idC, row } from "./fixtures.ts";

const keys = { enter: "\r", escape: "\x1b", down: "\x1b[B", up: "\x1b[A", right: "\x1b[C", tab: "\t", ctrlN: "\x0e" };
const projects = [
	{ id: "nexus", repoUrl: "git@example.com:nexus", defaultNode: "firebat", defaultBranch: "main" },
	{ id: "site", repoUrl: "git@example.com:site", defaultNode: "nuc", defaultBranch: "trunk" },
];

describe("picker", () => {
	const threads = [
		row(idA, { project: "nexus", title: "Fix the probe retry", agentTurnRunning: true, createdAt: asked }),
		row(idB, { project: "nexus", title: "Docs pass", createdAt: asked - 1, desired: "paused", pylon: { node: "firebat", actualState: "paused", failed: null } }),
		row(idC, { project: "nexus", title: "Old work", status: "archived", desired: "deleted", pylon: { node: "firebat", actualState: "absent", failed: null } }),
	];

	function open(width = 140) {
		const ends: PickerEnd[] = [];
		const picker = new Picker(fakeTui(), piTheme(), (end) => ends.push(end), () => asked + 60_000);
		picker.focused = true;
		picker.setThreads(threads, projects);
		return { picker, ends, text: () => plain(picker.render(width)), press: (k: string) => picker.handleInput(k) };
	}

	test("shows each project's threads with the overview columns and the closed ones folded", () => {
		const out = open().text();
		expect(out).toContain("Nexus threads");
		expect(out).toContain("→ + New thread");
		expect(out).toMatch(/nexus 2\n/);
		expect(out).toMatch(/● Fix the probe retry +agent working  wanted running  running  firebat  human never  agent turn running  1 min/);
		// The columns line up across rows.
		const [fix, docs] = out.split("\n").filter((l) => l.includes("●"));
		for (const column of ["wanted", "firebat", "human never", "1 min"]) expect(docs!.indexOf(column)).toBe(fix!.indexOf(column));
		expect(docs).toContain("wanted paused");
		expect(out).toContain("▸ 1 archived");
		expect(out).not.toContain("Old work");
		expect(out).toMatch(/site 0\n/);
	});

	test("narrow terminals drop columns before they cut the title", () => {
		expect(open(110).text()).toMatch(/● Fix the probe retry +agent working  wanted running  running  firebat  1 min\n/);
		expect(open(50).text()).toMatch(/● Fix the probe retry +agent working {2}1 min\n/);
	});

	test("Enter opens a thread or unfolds the closed ones", () => {
		const p = open();
		p.press(keys.down);
		p.press(keys.enter);
		expect(p.ends).toEqual([{ kind: "open", thread: idA }]);
		const q = open();
		for (let i = 0; i < 3; i++) q.press(keys.down);
		q.press(keys.enter);
		expect(q.text()).toContain("▾ 1 archived");
		expect(q.text()).toContain("Old work");
	});

	test("typing filters, Esc clears the filter and then closes", () => {
		const p = open();
		for (const ch of "docs") p.press(ch);
		expect(p.text()).toContain("Docs pass");
		expect(p.text()).not.toContain("Fix the probe retry");
		p.press(keys.enter);
		expect(p.ends).toEqual([{ kind: "open", thread: idB }]);
		const q = open();
		for (const ch of "zzz") q.press(ch);
		expect(q.text()).toContain("No thread matches.");
		q.press(keys.escape);
		expect(q.text()).toContain("Fix the probe retry");
		q.press(keys.escape);
		expect(q.ends).toEqual([{ kind: "close" }]);
	});

	test("ctrl+n starts a thread on the selected thread's project", () => {
		const p = open();
		p.press(keys.down);
		p.press(keys.ctrlN);
		expect(p.ends).toEqual([{ kind: "new", project: "nexus" }]);
	});

	test("a failed read shows, and the threads it had stay", () => {
		const p = open();
		p.picker.setError("The threads could not be read: unreachable");
		expect(p.text()).toContain("The threads could not be read: unreachable");
		expect(p.text()).toContain("Fix the probe retry");
	});
});

describe("start form", () => {
	function open(nodes: ConstructorParameters<typeof StartFormView>[0]["nodes"] = [{ name: "firebat", state: "online" }, { name: "nuc", state: "offline" }], initial = {}, fail?: string) {
		const started: StartForm[] = [];
		let cancelled = 0;
		const form = new StartFormView({
			tui: fakeTui(),
			theme: piTheme(),
			keybindings: keybindings(),
			projects,
			nodes,
			initial,
			async start(f) {
				started.push(f);
				if (fail) throw new Error(fail);
			},
			cancel: () => cancelled++,
		});
		form.focused = true;
		const press = (k: string) => form.handleInput(k);
		const type = (text: string) => [...text].forEach(press);
		return { form, started, cancelled: () => cancelled, text: () => plain(form.render(100)), press, type };
	}
	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

	test("starts with the project's defaults and says what it boots", () => {
		const out = open().text();
		expect(out).toContain("Start a thread");
		expect(out).toContain("[nexus]");
		expect(out).toContain("git@example.com:nexus");
		expect(out).toContain("[firebat (project default)]");
		expect(out).toContain("nuc, offline");
		expect(out).toContain("Boots a pylon on firebat and checks out main.");
	});

	test("tab moves between fields, arrows choose, and Enter in the message starts", async () => {
		const f = open();
		f.type("Fix the probe");
		f.press(keys.tab);
		f.press(keys.right);
		expect(f.text()).toContain("Boots a pylon on nuc and checks out trunk.");
		f.press(keys.tab);
		f.press(keys.right);
		f.press(keys.right);
		f.press(keys.tab);
		f.type("dev");
		f.press(keys.tab);
		f.type("make it back off");
		f.press(keys.enter);
		await settle();
		expect(f.started).toEqual([{ title: "Fix the probe", project: "site", node: "nuc", branch: "dev", message: "make it back off" }]);
	});

	test("a failed start shows its error and keeps the message", async () => {
		const f = open(undefined, {}, "nexus (conflict): no image is current");
		f.type("Title");
		for (let i = 0; i < 4; i++) f.press(keys.tab);
		f.type("go");
		f.press(keys.enter);
		await settle();
		expect(f.text()).toContain("nexus (conflict): no image is current");
		f.press(keys.enter);
		await settle();
		expect(f.started.map((s) => s.message)).toEqual(["go", "go"]);
	});

	test("needs a title or a message", async () => {
		const f = open();
		for (let i = 0; i < 4; i++) f.press(keys.tab);
		f.press(keys.enter);
		await settle();
		expect(f.started).toEqual([]);
		expect(f.text()).toContain("A thread needs a title or a first message.");
	});

	test("Start again prefills the project and title", () => {
		const out = open(undefined, { project: "site", title: "Again" }).text();
		expect(out).toContain("[site]");
		expect(out).toContain("Again");
	});

	test("an unknown project is an error the form shows, not the first project, until one is chosen", async () => {
		const f = open(undefined, { project: "typo", title: "Fix it" });
		expect(f.text()).toContain("There is no project typo. Choose one with ←→ in Project.");
		expect(f.text()).not.toContain("[nexus]");
		for (let i = 0; i < 4; i++) f.press(keys.tab);
		f.press(keys.enter);
		await settle();
		expect(f.started).toEqual([]);
		f.press(keys.tab);
		f.press(keys.tab);
		f.press(keys.right);
		expect(f.text()).toContain("[nexus]");
		expect(f.text()).not.toContain("There is no project");
		for (let i = 0; i < 3; i++) f.press(keys.tab);
		f.press(keys.enter);
		await settle();
		expect(f.started.map((s) => s.project)).toEqual(["nexus"]);
	});

	test("without nodes it offers only the project default and says why", () => {
		const out = open(new Error("nodes failed")).text();
		expect(out).toContain("[firebat (project default)]");
		expect(out).toContain("Only the project default, since the nodes are unavailable: nodes failed");
	});

	test("Esc waits for a start under way, so the thread it makes is not hidden", async () => {
		let finish = () => {};
		let cancelled = 0;
		const form = new StartFormView({
			tui: fakeTui(),
			theme: piTheme(),
			keybindings: keybindings(),
			projects,
			nodes: [],
			start: () => new Promise<void>((resolve) => (finish = resolve)),
			cancel: () => cancelled++,
		});
		form.focused = true;
		for (const ch of "Title") form.handleInput(ch);
		for (let i = 0; i < 4; i++) form.handleInput(keys.tab);
		form.handleInput(keys.enter);
		form.handleInput(keys.escape);
		expect(cancelled).toBe(0);
		expect(plain(form.render(100))).toContain("Starting the thread. Esc closes the form once the CLI answers.");
		finish();
		await settle();
		form.handleInput(keys.escape);
		expect(cancelled).toBe(1);
	});

	test("Esc cancels", () => {
		const f = open();
		f.press(keys.escape);
		expect(f.cancelled()).toBe(1);
	});
});
