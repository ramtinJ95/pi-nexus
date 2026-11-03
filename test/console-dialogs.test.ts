import { describe, expect, test } from "bun:test";
import { Picker, type PickerEnd } from "../extensions/nexus/console/picker.ts";
import { ProjectFormView, type ProjectForm } from "../extensions/nexus/console/project-form.ts";
import { ProjectPicker, type ProjectEnd } from "../extensions/nexus/console/project-picker.ts";
import { StartFormView } from "../extensions/nexus/console/start-form.ts";
import type { StartForm } from "../extensions/nexus/console/model.ts";
import { asked, fakeTui, keybindings, piTheme, plain } from "./console-fixture.ts";
import type { ThreadRow } from "../extensions/nexus/contract.ts";
import { NexusError } from "../extensions/nexus/thread.ts";
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

	function open(width = 140, list: ThreadRow[] = threads, scope: string | null = null) {
		const ends: PickerEnd[] = [];
		const picker = new Picker(fakeTui(), piTheme(), (end) => ends.push(end), () => asked + 60_000);
		picker.focused = true;
		picker.setThreads(list, projects, scope);
		const press = (...input: string[]) => input.forEach((k) => picker.handleInput(k));
		return { picker, ends, text: () => plain(picker.render(width)), press };
	}

	test("shows each project's threads newest first, each a dot, its title and its age, with the closed ones folded", () => {
		const out = open().text();
		expect(out).toContain("Nexus threads");
		expect(out).toContain("→ + New thread");
		expect(out).toMatch(/▾ nexus  main\n/);
		expect(out).toMatch(/\n   ◉ Fix the probe retry +working\n/);
		expect(out).toMatch(/\n   ○ Docs pass +1 min\n/);
		expect(out).not.toMatch(/wanted|firebat|human|agent turn/);
		expect(out).toContain("▸ 1 archived");
		expect(out).not.toContain("Old work");
		expect(out).toMatch(/▾ site  trunk\n/);
	});

	test("ages and words sit at the right edge, whatever the width, a new reply adds no word, and a narrow terminal cuts the title rather than them", () => {
		const list = [
			{ ...threads[0]!, title: "Fix the probe retry so that it backs off and gives up after a while", workingSince: asked - 11 * 60_000 },
			{ ...threads[1]!, createdAt: asked - 11 * 60_000, attention: "reply" },
		];
		for (const width of [140, 60, 40]) {
			const [fix, docs] = open(width, list).text().split("\n").filter((l) => /[◉●○]/.test(l));
			expect(fix).toEndWith("working 12 min");
			expect(docs).toMatch(/Docs pass +12 min$/);
			expect(fix!.length).toBe(width);
			expect(docs!.length).toBe(width);
		}
		expect(open(40, list).text()).toMatch(/◉ Fix the probe \S*\.\.\. +working 12 min\n/);
	});

	test("colour shows only where a thread asks something of you: a running pylon whose agent is idle is dim, not green, and a new reply only colours its dot", () => {
		const t = piTheme();
		const list = [
			row(idA, { project: "nexus", title: "Idle on a running pylon", createdAt: asked }),
			row(idB, { project: "nexus", title: "Unread", createdAt: asked - 1, attention: "reply" }),
			row(idC, { project: "nexus", title: "Broken", createdAt: asked - 2, attention: "failed", pylon: { node: "firebat", actualState: "failed", failed: "boom" } }),
		];
		const lines = open(140, list).picker.render(140);
		const line = (title: string) => lines.find((l) => l.includes(title))!;
		expect(line("Idle on a running pylon")).toContain(t.fg("dim", "●"));
		expect(lines.join("\n")).not.toContain(t.fg("success", "●"));
		expect(line("Unread")).toContain(t.fg("accent", "●"));
		expect(line("Unread")).toContain(t.fg("muted", "Unread"));
		expect(lines.join("\n")).not.toContain("new reply");
		expect(line("Broken")).toContain(t.fg("error", "✕"));
		expect(line("Broken")).toContain(t.fg("error", "failed"));
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

	test("/ or f filters, Enter keeps the filter for j and k, and Esc clears it before it goes back", () => {
		const p = open();
		p.press("/", ..."docs");
		expect(p.text()).toContain("Docs pass");
		expect(p.text()).not.toContain("Fix the probe retry");
		p.press(keys.enter);
		expect(p.text()).toContain("filter: docs");
		p.press("o");
		expect(p.ends).toEqual([{ kind: "open", thread: idB }]);
		const q = open();
		q.press("/", ..."zzz");
		expect(q.text()).toContain("No thread matches.");
		q.press(keys.escape);
		expect(q.text()).toContain("Fix the probe retry");
		q.press(keys.escape);
		expect(q.ends).toEqual([{ kind: "back" }]);
		const r = open();
		r.press("f");
		expect(r.text()).toMatch(/\n FILTER {2}/);
		r.press("x", keys.enter);
		expect(r.text()).toMatch(/\n NORMAL {2}/);
		r.press(keys.escape);
		expect(r.ends).toEqual([]);
		expect(r.text()).not.toContain("filter:");
		r.press(keys.escape);
		expect(r.ends).toEqual([{ kind: "back" }]);
	});

	test("vim's keys move and open, q closes, and the arrows still work", () => {
		const p = open();
		p.press("j");
		expect(p.text()).toMatch(/→ ◉ Fix the probe retry/);
		p.press("j", "k", keys.down, keys.up);
		expect(p.text()).toMatch(/→ ◉ Fix the probe retry/);
		p.press("G");
		expect(p.text()).toMatch(/→ ▸ 1 archived/);
		p.press("g", "g");
		expect(p.text()).toContain("→ + New thread");
		p.press("g", "e");
		expect(p.text()).toMatch(/→ ▸ 1 archived/);
		p.press("u");
		expect(p.text()).toContain("→ + New thread");
		p.press("j", "l");
		expect(p.ends).toEqual([{ kind: "open", thread: idA }]);
		p.press("d", "u", "j", "o");
		expect(p.ends).toEqual([{ kind: "open", thread: idA }, { kind: "open", thread: idA }]);
		const q = open();
		q.press("q");
		expect(q.ends).toEqual([{ kind: "close" }]);
	});

	test("? lists the keys, and any key closes the list without acting", () => {
		const p = open();
		p.press("?");
		expect(p.text()).toContain("j/↓");
		expect(p.text()).toContain("filter by title or ID");
		expect(p.text()).not.toContain("Fix the probe retry");
		p.press("q");
		expect(p.ends).toEqual([]);
		expect(p.text()).toContain("Fix the probe retry");
	});

	test("s lists the keys too, and r reads the threads again", () => {
		let reads = 0;
		const picker = new Picker(fakeTui(), piTheme(), () => {}, () => asked + 60_000, undefined, () => reads++);
		picker.setThreads(threads, projects, null);
		picker.handleInput("s");
		expect(plain(picker.render(140))).toContain("read the threads again");
		picker.handleInput("j");
		picker.handleInput("r");
		expect(reads).toBe(1);
	});

	test("n and ctrl+n start a thread on the selected thread's project", () => {
		const p = open();
		p.press(keys.down, "n");
		p.press(keys.ctrlN);
		expect(p.ends).toEqual([
			{ kind: "new", project: "nexus" },
			{ kind: "new", project: "nexus" },
		]);
	});

	test("what needs you to act lists first, under Needs you, in the control plane's order with its words, and a new reply stays in its project with no word", () => {
		const marked = (title: string, attention: string | null, extra: Partial<ThreadRow> = {}) =>
			row(`th-0000000000${title.length.toString(16).padStart(2, "0")}`, { project: "nexus", title, createdAt: asked - title.length, attention, ...extra });
		const list = [
			threads[0]!,
			marked("Waiting session", "waiting"),
			marked("Failed pylon", "failed", { pylon: { node: "firebat", actualState: "failed", failed: "git clone: denied" } }),
			marked("Parked tasks", "parked"),
			marked("Out of usage", "limited"),
			marked("A decision for me", "decision", { project: "site" }),
			marked("Unseen reply", "reply"),
			marked("Agent at work", "working"),
			marked("From the future", "stalled"),
			marked("Archived reply", "reply", { status: "archived" }),
		];
		const out = open(140, list).text();
		const needs = out.slice(out.indexOf("Needs you 5"), out.indexOf("▾ nexus"));
		expect(needs.split("\n").filter((l) => l.trim() !== "").slice(1).map((l) => l.trim().replace(/ {2,}/g, " | "))).toEqual([
			"✕ nexus / Failed pylon | failed | 1 min",
			"! site / A decision for me | needs your decision | 1 min",
			"✕ nexus / Parked tasks | parked | 1 min",
			"◷ nexus / Out of usage | usage limit | 1 min",
			"◇ nexus / Waiting session | waiting for input | 1 min",
		]);
		const nexus = out.slice(out.indexOf("▾ nexus"));
		expect(nexus).toMatch(/● Unseen reply +1 min\n/);
		expect(nexus).toMatch(/◉ Agent at work +working\n/);
		expect(nexus).toMatch(/● From the future +1 min\n/);
		expect(nexus).not.toContain("Failed pylon");
		expect(out).not.toContain("Archived reply");
	});

	test("a thread quiet for over 8 hours, its pylon down and its agent idle, folds under its project, even with an unread reply", () => {
		const hours = (h: number) => asked + 60_000 - h * 3_600_000;
		const paused = { node: "firebat", actualState: "paused", failed: null };
		const list = [
			row(idA, { project: "nexus", title: "Asleep a day", createdAt: hours(24), desired: "paused", pylon: paused }),
			row(idB, { project: "nexus", title: "Asleep with news", createdAt: hours(30), lastReplyAt: hours(9), attention: "reply", desired: "paused", pylon: paused }),
			row(idC, { project: "nexus", title: "Paused an hour ago", createdAt: hours(1), desired: "paused", pylon: paused }),
			row("th-0000000000a1", { project: "nexus", title: "Running all night", createdAt: hours(20) }),
			row("th-0000000000a2", { project: "nexus", title: "Working all night", createdAt: hours(20), agentTurnRunning: true, pylon: paused }),
		];
		const p = open(140, list);
		const out = p.text();
		for (const title of ["Paused an hour ago", "Running all night", "Working all night"]) expect(out).toContain(title);
		expect(out).toContain("▸ 2 quiet for over 8 hours");
		expect(out).not.toContain("Asleep");
		for (let i = 0; i < 4; i++) p.press("j");
		p.press(keys.enter);
		expect(p.text()).toContain("▾ 2 quiet for over 8 hours");
		expect(p.text()).toMatch(/○ Asleep a day +24 h\n/);
		expect(p.text()).toMatch(/○ Asleep with news +9 h\n/);
	});

	test("the selected row says where its pylon is and what is wanted of it, when you and the agent were last active, and its ID", () => {
		const list = [
			row(idA, { project: "nexus", title: "Pausing", createdAt: asked, lastHumanActivityAt: asked - 5 * 60_000, lastAgentActivityAt: asked, pylon: { node: "nuc", actualState: "running", failed: null }, desired: "paused" }),
			row(idB, { project: "nexus", title: "Settled", createdAt: asked - 1 }),
		];
		const p = open(140, list);
		p.press("j");
		expect(p.text()).toMatch(new RegExp(`→ ● Pausing .*\\n {5}running on nuc · wants paused · you 6 min · agent 1 min · ${idA}\\n`));
		p.press("j");
		expect(p.text()).toMatch(new RegExp(`→ ● Settled .*\\n {5}running on firebat · you never · agent never · ${idB}\\n`));
		expect(p.text()).not.toContain(idA);
	});

	test("the hints that fit show whole, and the key help always shows", () => {
		const wide = open(140).text().split("\n").find((l) => l.includes("NORMAL"))!;
		expect(wide.trim()).toBe("NORMAL  j/k navigate  enter open or unfold  n new thread  p project  f filter  q close  s keys");
		const narrow = open(60).text().split("\n").find((l) => l.includes("NORMAL"))!;
		expect(narrow.trim()).toBe("NORMAL  j/k navigate  enter open or unfold  s keys");
	});

	test("opens on the thread it is given, once the threads load", () => {
		const ends: PickerEnd[] = [];
		const picker = new Picker(fakeTui(), piTheme(), (end) => ends.push(end), () => asked + 60_000, idB);
		picker.setThreads(threads, projects, null);
		picker.handleInput(keys.enter);
		expect(ends).toEqual([{ kind: "open", thread: idB }]);
	});

	test("a project scope shows only that project's threads and names it in the header, and p asks for another", () => {
		const list = [...threads, row("th-5173aaaabbbb", { project: "site", title: "Landing page" })];
		const all = open(140, list).text();
		expect(all).toContain("Nexus threads · All projects");
		expect(all).toContain("Fix the probe retry");
		expect(all).toContain("Landing page");
		const site = open(140, list, "site");
		expect(site.text()).toContain("Nexus threads · site");
		expect(site.text()).toContain("Landing page");
		expect(site.text()).not.toContain("Fix the probe retry");
		expect(site.text()).not.toMatch(/nexus 2\n/);
		expect(site.text()).toContain("p project");
		site.press("p");
		expect(site.ends).toEqual([{ kind: "projects" }]);
	});

	test("a failed read shows, and the threads it had stay", () => {
		const p = open();
		p.picker.setError("The threads could not be read: unreachable");
		expect(p.text()).toContain("The threads could not be read: unreachable");
		expect(p.text()).toContain("Fix the probe retry");
	});
});

describe("project picker", () => {
	function open(current: string | null = null, loaded = true) {
		const ends: ProjectEnd[] = [];
		const picker = new ProjectPicker(fakeTui(), piTheme(), (end) => ends.push(end), current);
		picker.focused = true;
		if (loaded) picker.setProjects(projects);
		const press = (...input: string[]) => input.forEach((k) => picker.handleInput(k));
		return { picker, ends, text: () => plain(picker.render(100)), press };
	}

	test("lists All projects, each project with its repo URL, then New project, the current scope selected", () => {
		const out = open().text();
		expect(out).toContain("Projects");
		expect(out).toMatch(/→ All projects +current\n/);
		expect(out).toMatch(/ {3}nexus +git@example\.com:nexus\n/);
		expect(out).toMatch(/ {3}site +git@example\.com:site\n/);
		expect(out).toContain("+ New project…");
		expect(open("site").text()).toMatch(/→ site +git@example\.com:site +current\n/);
	});

	test("j and k move, gg and ge jump, Enter or o chooses, and q or Esc cancels", () => {
		const p = open();
		p.press("j", "\r");
		expect(p.ends).toEqual([{ kind: "scope", project: "nexus" }]);
		const q = open("site");
		q.press("k", "k", "o");
		expect(q.ends).toEqual([{ kind: "scope", project: null }]);
		const r = open();
		r.press("g", "e", "\r");
		expect(r.ends).toEqual([{ kind: "new" }]);
		const s = open("site");
		s.press("g", "g", keys.down, "o");
		expect(s.ends).toEqual([{ kind: "scope", project: "nexus" }]);
		const t = open();
		t.press("G", "k", "\r");
		expect(t.ends).toEqual([{ kind: "scope", project: "site" }]);
		const u = open();
		u.press("q");
		const v = open();
		v.press(keys.escape);
		expect([...u.ends, ...v.ends]).toEqual([{ kind: "cancel" }, { kind: "cancel" }]);
	});

	test("many projects scroll, keeping the selected row in sight", () => {
		const many = Array.from({ length: 30 }, (_, i) => ({ id: `p${String(i).padStart(2, "0")}`, repoUrl: `git@example.com:p${i}`, defaultNode: "firebat", defaultBranch: "main" }));
		const picker = new ProjectPicker(fakeTui(), piTheme(), () => {}, "p20");
		picker.setProjects(many);
		const text = () => plain(picker.render(100));
		expect(text().split("\n").length).toBeLessThan(25);
		expect(text()).toMatch(/→ p20 .*current\n/);
		expect(text()).toContain("(22/32)");
		picker.handleInput("G");
		expect(text()).toContain("→ + New project…");
		picker.handleInput("g");
		picker.handleInput("g");
		expect(text()).toContain("→ All projects");
		expect(text()).not.toContain("New project");
	});

	test("before the projects load, and when they cannot be read, All projects and New project still work", () => {
		const p = open("site", false);
		expect(p.text()).toContain("Reading the projects...");
		p.picker.setError("The projects could not be read: unreachable");
		expect(p.text()).toContain("The projects could not be read: unreachable");
		p.press("G", "\r");
		expect(p.ends).toEqual([{ kind: "new" }]);
	});
});

describe("new project form", () => {
	const nodes = [
		{ name: "nuc", state: "offline" as const },
		{ name: "firebat", state: "online" as const },
	];
	function open(available: ConstructorParameters<typeof ProjectFormView>[0]["nodes"] = nodes, fail?: Error) {
		const added: ProjectForm[] = [];
		let cancelled = 0;
		const form = new ProjectFormView({
			tui: fakeTui(),
			theme: piTheme(),
			nodes: available,
			async add(f) {
				added.push(f);
				if (fail) throw fail;
			},
			cancel: () => cancelled++,
		});
		form.focused = true;
		const press = (...input: string[]) => input.forEach((k) => form.handleInput(k));
		const type = (text: string) => press(...text);
		return { form, added, cancelled: () => cancelled, text: () => plain(form.render(100)), press, type };
	}
	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

	test("defaults to the first online node and the main branch", () => {
		const out = open().text();
		expect(out).toContain("Add a project");
		expect(out).toContain("[firebat]");
		expect(out).toContain("nuc, offline");
		expect(out).toMatch(/Branch +> main\n/);
	});

	test("Enter moves to the next field and adds from the last, with what each field holds", async () => {
		const f = open();
		f.type("spoon");
		f.press(keys.enter);
		f.type("git@github.com:me/spoon.git");
		f.press(keys.enter);
		f.press(keys.right, keys.enter);
		expect(f.added).toEqual([]);
		f.type("trunk");
		f.press(keys.enter);
		await settle();
		expect(f.added).toEqual([{ id: "spoon", repoUrl: "git@github.com:me/spoon.git", node: "nuc", branch: "trunk" }]);
	});

	test("a failed add shows the CLI's message as it is, and keeps the fields", async () => {
		for (const message of ["project spoon already exists", "invalid project id Spoon!: use lowercase letters, digits and dashes"]) {
			const f = open(nodes, new NexusError(message.startsWith("invalid") ? "invalid" : "conflict", message));
			f.type("spoon");
			f.press(keys.tab);
			f.type("git@github.com:me/spoon.git");
			f.press(keys.tab, keys.tab, keys.enter);
			await settle();
			expect(f.added).toEqual([{ id: "spoon", repoUrl: "git@github.com:me/spoon.git", node: "firebat", branch: "main" }]);
			expect(f.text()).toContain(message);
			expect(f.text()).toContain("git@github.com:me/spoon.git");
			f.press(keys.enter);
			await settle();
			expect(f.added).toHaveLength(2);
		}
	});

	test("needs an ID, a repo URL and a node", async () => {
		const f = open();
		f.press(keys.tab, keys.tab, keys.tab, keys.enter);
		await settle();
		expect(f.text()).toContain("A project needs an ID.");
		f.press(keys.tab);
		f.type("spoon");
		f.press(keys.tab, keys.tab, keys.tab, keys.enter);
		await settle();
		expect(f.text()).toContain("A project needs a repo URL.");
		const g = open(new Error("unreachable"));
		expect(g.text()).toContain("The nodes could not be read, so there is no node to add the project on: unreachable");
		g.type("spoon");
		g.press(keys.tab);
		g.type("git@x:spoon");
		g.press(keys.tab, keys.tab, keys.enter);
		await settle();
		expect(g.added).toEqual([]);
		expect(open([]).text()).toContain("No nodes yet, so there is no node to add the project on.");
		expect(f.added).toEqual([]);
	});

	test("Esc cancels, but waits for an add under way", async () => {
		const f = open();
		f.press(keys.escape);
		expect(f.cancelled()).toBe(1);
		let finish = () => {};
		let cancelled = 0;
		const form = new ProjectFormView({ tui: fakeTui(), theme: piTheme(), nodes, add: () => new Promise<void>((resolve) => (finish = resolve)), cancel: () => cancelled++ });
		form.focused = true;
		for (const ch of "spoon") form.handleInput(ch);
		form.handleInput(keys.tab);
		for (const ch of "git@x:spoon") form.handleInput(ch);
		form.handleInput(keys.tab);
		form.handleInput(keys.tab);
		form.handleInput(keys.enter);
		form.handleInput(keys.escape);
		expect(cancelled).toBe(0);
		expect(plain(form.render(100))).toContain("Adding the project. Esc closes the form once the CLI answers.");
		finish();
		await settle();
		form.handleInput(keys.escape);
		expect(cancelled).toBe(1);
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
