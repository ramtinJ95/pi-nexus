import { describe, expect, test } from "bun:test";
import { Picker, type PickerEnd } from "../extensions/nexus/console/picker.ts";
import { ProjectFormView, type ProjectForm } from "../extensions/nexus/console/project-form.ts";
import { ProjectPicker, type ProjectEnd } from "../extensions/nexus/console/project-picker.ts";
import { StartFormView } from "../extensions/nexus/console/start-form.ts";
import type { StartForm } from "../extensions/nexus/console/model.ts";
import { asked, fakeTui, keybindings, piTheme, plain } from "./console-fixture.ts";
import type { ThreadRow } from "../extensions/nexus/contract.ts";
import type { Seen } from "../extensions/nexus/store.ts";
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

	function open(width = 140, seen: Seen = { since: asked + 60_000, threads: {} }, list: ThreadRow[] = threads, parked = new Map<string, number>(), scope: string | null = null) {
		const ends: PickerEnd[] = [];
		const picker = new Picker(fakeTui(), piTheme(), (end) => ends.push(end), () => asked + 60_000);
		picker.focused = true;
		picker.setThreads(list, projects, { seen, parked }, scope);
		const press = (...input: string[]) => input.forEach((k) => picker.handleInput(k));
		return { picker, ends, text: () => plain(picker.render(width)), press };
	}

	test("shows each project's threads with the overview columns and the closed ones folded", () => {
		const out = open().text();
		expect(out).toContain("Nexus threads");
		expect(out).toContain("→ + New thread");
		expect(out).toMatch(/▾ nexus  main\n/);
		expect(out).toMatch(/● Fix the probe retry +agent working  wanted running  running  firebat  human never  agent turn running  1 min/);
		// The columns line up across rows.
		const [fix, docs] = out.split("\n").filter((l) => l.includes("●"));
		for (const column of ["wanted", "firebat", "human never", "1 min"]) expect(docs!.indexOf(column)).toBe(fix!.indexOf(column));
		expect(docs).toContain("wanted paused");
		expect(out).toContain("▸ 1 archived");
		expect(out).not.toContain("Old work");
		expect(out).toMatch(/▾ site  trunk\n/);
	});

	test("different activity ages do not shift the overview columns", () => {
		const list = [
			{ ...threads[0]!, createdAt: asked + 60_000 },
			{ ...threads[1]!, createdAt: asked - 11 * 60_000 },
		];
		for (const width of [140, 110]) {
			const [fix, docs] = open(width, undefined, list).text().split("\n").filter((l) => l.includes("●"));
			expect(fix).toEndWith("now");
			expect(docs).toEndWith("12 min");
			expect(fix!.length).toBe(width);
			expect(docs!.length).toBe(width);
			for (const column of ["wanted", "firebat", ...(width === 140 ? ["human never", "agent "] : [])]) expect(docs!.indexOf(column)).toBe(fix!.lastIndexOf(column));
		}
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
		expect(p.text()).toMatch(/→ ● Fix the probe retry/);
		p.press("j", "k", keys.down, keys.up);
		expect(p.text()).toMatch(/→ ● Fix the probe retry/);
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
		picker.setThreads(threads, projects, { seen: { since: 0, threads: {} }, parked: new Map() }, null);
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

	test("a failed pylon needs you, and an agent that answered since the last look is new", () => {
		const failed = row(idB, { project: "nexus", title: "Docs pass", createdAt: asked - 1, pylon: { node: "firebat", actualState: "failed", failed: "git clone: denied" } });
		const answered = row(idC, { project: "nexus", title: "Answered", createdAt: asked - 2, lastAgentActivityAt: asked + 30_000 });
		const looked = row("th-00000000000d", { project: "nexus", title: "Looked at", createdAt: asked - 3, lastAgentActivityAt: asked + 30_000 });
		const list = [threads[0]!, failed, answered, looked];
		const out = open(140, { since: asked, threads: { "th-00000000000d": asked + 40_000 } }, list).text();
		expect(out).toMatch(/● Docs pass needs you +failed/);
		expect(out).toMatch(/● Answered new /);
		expect(out).not.toMatch(/Looked at new/);
		// A working agent is not done yet, so its thread is not new.
		expect(out).not.toMatch(/Fix the probe retry new/);
		// Nobody has looked since the store began, so an answer before then is not new.
		expect(open(140, { since: asked + 31_000, threads: {} }, list).text()).not.toMatch(/Answered new/);
	});

	test("a thread seen parked needs you until its agent does something after that", () => {
		const parked = new Map([[idB, asked + 10_000]]);
		const seen = { since: asked + 60_000, threads: {} };
		const stuck = row(idB, { project: "nexus", title: "Docs pass", createdAt: asked - 1, lastAgentActivityAt: asked + 5_000 });
		expect(open(140, seen, [threads[0]!, stuck], parked).text()).toMatch(/● Docs pass needs you /);
		// Retried since: the agent worked after the thread was seen parked.
		const retried = { ...stuck, lastAgentActivityAt: asked + 20_000 };
		expect(open(140, seen, [threads[0]!, retried], parked).text()).not.toMatch(/Docs pass needs you/);
	});

	test("opens on the thread it is given, once the threads load", () => {
		const ends: PickerEnd[] = [];
		const picker = new Picker(fakeTui(), piTheme(), (end) => ends.push(end), () => asked + 60_000, idB);
		picker.setThreads(threads, projects, { seen: { since: 0, threads: {} }, parked: new Map() }, null);
		picker.handleInput(keys.enter);
		expect(ends).toEqual([{ kind: "open", thread: idB }]);
	});

	test("a project scope shows only that project's threads and names it in the header, and p asks for another", () => {
		const list = [...threads, row("th-5173aaaabbbb", { project: "site", title: "Landing page" })];
		const all = open(140, undefined, list).text();
		expect(all).toContain("Nexus threads · All projects");
		expect(all).toContain("Fix the probe retry");
		expect(all).toContain("Landing page");
		const site = open(140, undefined, list, undefined, "site");
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
