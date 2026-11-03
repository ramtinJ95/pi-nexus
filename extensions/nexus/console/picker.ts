/**
 * The thread picker, in pi's selector look, after the dashboard's home: what needs you to act first, under Needs you,
 * then each project's threads, newest first, the ones quiet for over 8 hours and the archived or deleted ones folded.
 * Words show only where the control plane's attention, which every client shares, needs the person to act: such a
 * row is bright, with its dot in the attention's colour and its word beside its age. Every other row is dim, its
 * dot's shape its state, as the dashboard dims it, and a reply nobody has marked seen only colours that dot.
 * The selected row says where its pylon is, when you and the agent were last active, and its ID. It shows the project
 * chosen with p, or every project.
 *
 * Its keys are vim's, as the thread view's are: j and k move, / filters as pi's session picker does when you type,
 * and Enter accepts the filter.
 */
import { DynamicBorder, rawKeyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { Project, ThreadRow } from "../contract.ts";
import { inScope, scopeLabel } from "../scope.ts";
import { isWorking } from "../thread.ts";
import { helpLines, hint, KeyReader, modeLine, type Binding } from "./keys.ts";
import { badge, foldKey, lastActive, lookOf, overview, pickerRows, span, threadState, toneColor, toneGlyph, wanting, type PickerRow } from "./model.ts";

/** `back` returns to where the picker was opened from; `projects` chooses the project shown; `close` leaves the console. */
export type PickerEnd = { kind: "open"; thread: string } | { kind: "new"; project?: string } | { kind: "projects" } | { kind: "back" } | { kind: "close" };

const selectable = (row: PickerRow) => row.kind === "thread" || row.kind === "fold" || row.kind === "new";
const visibleRows = 14;

type Command = "down" | "up" | "halfDown" | "halfUp" | "top" | "bottom" | "open" | "new" | "projects" | "filter" | "refresh" | "help" | "back" | "close";

/** The Claude Code Nexus mod's keys, with vim's own where pi can read them, as the thread view's are. */
const pickerKeys: readonly Binding<Command>[] = [
	{ keys: ["j", "down"], command: "down", help: "the next thread" },
	{ keys: ["k", "up"], command: "up", help: "the previous thread" },
	{ keys: ["d", "ctrl+d"], command: "halfDown", help: "half a page down" },
	{ keys: ["u", "ctrl+u"], command: "halfUp", help: "half a page up" },
	{ keys: ["gg", "home"], command: "top", help: "the first row" },
	{ keys: ["G", "ge", "end"], command: "bottom", help: "the last row" },
	{ keys: ["enter", "o", "l"], command: "open", help: "open the thread, or unfold its project's archived threads" },
	{ keys: ["n", "ctrl+n"], command: "new", help: "start a thread, on the selected thread's project" },
	{ keys: ["p"], command: "projects", help: "choose the project whose threads show, or add one" },
	{ keys: ["f", "/"], command: "filter", help: "filter by title or ID; enter keeps the filter, esc clears it" },
	{ keys: ["r"], command: "refresh", help: "read the threads again" },
	{ keys: ["s", "?"], command: "help", help: "this help" },
	{ keys: ["escape"], command: "back", help: "clear the filter, or go back to the thread you came from" },
	{ keys: ["q"], command: "close", help: "close the console" },
];

export class Picker implements Component, Focusable {
	private readonly search = new Input();
	private readonly keys = new KeyReader(pickerKeys);
	private shown: ReturnType<typeof overview> = { needs: [], groups: [] };
	private readonly unfolded = new Set<string>();
	private rows: PickerRow[] = [];
	private selected = 0;
	private filtering = false;
	private help = false;
	private error: string | undefined;
	/** The project shown, or null for every project. */
	private scope: string | null = null;
	private projects: readonly Project[] = [];
	private _focused = false;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly done: (end: PickerEnd) => void,
		private readonly now: () => number = Date.now,
		/** The thread to select once the threads load: the one the picker was opened from, or the working one. */
		private at?: string,
		/** Reads the threads again, which come back through setThreads. */
		private readonly refresh: () => void = () => {},
	) {}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.search.focused = value && this.filtering;
	}

	/** The threads, and the projects, of which only `scope`'s show unless it is null. */
	setThreads(threads: readonly ThreadRow[], projects: readonly Project[], scope: string | null): void {
		const current = this.rows[this.selected];
		const keep = this.at ?? (current?.kind === "thread" ? current.thread.id : undefined);
		this.at = undefined;
		this.scope = scope;
		this.projects = projects;
		this.shown = overview(inScope(threads, scope), scope === null ? projects : projects.filter((p) => p.id === scope), this.now());
		this.error = undefined;
		this.layout();
		// The same thread stays selected across a refresh.
		if (keep !== undefined) {
			const again = this.rows.findIndex((r) => r.kind === "thread" && r.thread.id === keep);
			if (again !== -1) this.selected = again;
		}
		this.tui.requestRender();
	}

	setError(message: string): void {
		this.error = message;
		this.tui.requestRender();
	}

	private layout(): void {
		this.rows = pickerRows(this.shown, this.unfolded, this.search.getValue());
		if (!this.rows[this.selected] || !selectable(this.rows[this.selected]!)) this.selected = this.rows.findIndex(selectable);
	}

	/** Moves `by` selectable rows, stopping at the first or the last. */
	private move(by: number): void {
		const step = Math.sign(by);
		for (let i = this.selected + step, left = Math.abs(by); i >= 0 && i < this.rows.length && left > 0; i += step) {
			if (selectable(this.rows[i]!)) {
				this.selected = i;
				left--;
			}
		}
	}

	private setFiltering(on: boolean): void {
		this.filtering = on;
		this.focused = this._focused;
	}

	handleInput(data: string): void {
		if (this.help) this.help = false;
		else if (this.filtering) this.filterInput(data);
		else {
			const command = this.keys.read(data);
			if (command !== undefined) return this.run(command);
		}
		this.tui.requestRender();
	}

	/** While filtering, typing goes to the filter, and the arrows still move. */
	private filterInput(data: string): void {
		if (matchesKey(data, "down")) return this.move(1);
		if (matchesKey(data, "up")) return this.move(-1);
		if (matchesKey(data, "enter")) return this.setFiltering(false);
		if (matchesKey(data, "escape")) {
			this.search.setValue("");
			this.setFiltering(false);
		} else {
			this.search.handleInput(data);
			this.selected = 0;
		}
		this.layout();
	}

	private run(command: Command): void {
		const row = this.rows[this.selected];
		switch (command) {
			case "down":
				this.move(1);
				break;
			case "up":
				this.move(-1);
				break;
			case "halfDown":
				this.move(visibleRows / 2);
				break;
			case "halfUp":
				this.move(-visibleRows / 2);
				break;
			case "top":
				this.selected = this.rows.findIndex(selectable);
				break;
			case "bottom":
				this.selected = this.rows.length - 1 - [...this.rows].reverse().findIndex(selectable);
				break;
			case "open":
				if (row?.kind === "thread") return this.done({ kind: "open", thread: row.thread.id });
				if (row?.kind === "new") return this.done({ kind: "new" });
				if (row?.kind === "fold") {
					if (this.unfolded.has(foldKey(row))) this.unfolded.delete(foldKey(row));
					else this.unfolded.add(foldKey(row));
					this.layout();
				}
				break;
			case "new": {
				const project = this.projectOf(row);
				return this.done({ kind: "new", ...(project ? { project } : {}) });
			}
			case "projects":
				return this.done({ kind: "projects" });
			case "filter":
				this.setFiltering(true);
				break;
			case "refresh":
				this.refresh();
				break;
			case "help":
				this.help = true;
				break;
			case "back":
				if (this.search.getValue() === "") return this.done({ kind: "back" });
				this.search.setValue("");
				this.layout();
				break;
			case "close":
				return this.done({ kind: "close" });
		}
		this.tui.requestRender();
	}

	private projectOf(row: PickerRow | undefined): string | undefined {
		return row?.kind === "thread" ? row.thread.project : row?.kind === "fold" ? row.project : undefined;
	}

	/** A thread's row: its dot, its title, and on the right its age, after what it asks of the person when it asks anything. */
	private threadLine(th: ThreadRow, selected: boolean, needs: boolean, width: number): string {
		const t = this.theme;
		const look = lookOf(th);
		const asking = look?.asks === "act" ? look : null;
		const unread = look?.asks === "read" ? look : null;
		const [, tone] = threadState(th, th.pylon.actualState, isWorking(th));
		const since = th.workingSince === undefined ? null : span(th.workingSince, this.now());
		const age = isWorking(th) && !asking ? ["working", since].filter(Boolean).join(" ") : (span(lastActive(th), this.now()) ?? "now");
		const right = `${asking ? `${t.fg(toneColor[asking.tone], asking.word)}  ` : ""}${t.fg("dim", age.padStart(6))}`;
		const dot = asking ? t.fg(toneColor[asking.tone], asking.glyph) : unread ? t.fg(toneColor[unread.tone], toneGlyph[tone]) : t.fg("dim", toneGlyph[tone]);
		const project = needs ? t.fg("dim", `${th.project} / `) : "";
		const title = selected ? t.fg("accent", th.title) : asking ? th.title : t.fg("muted", th.title);
		const left = truncateToWidth(` ${selected ? t.fg("accent", "→ ") : "  "}${dot} ${project}${title}`, Math.max(10, width - visibleWidth(right) - 2));
		return `${left}${" ".repeat(Math.max(2, width - visibleWidth(left) - visibleWidth(right)))}${right}`;
	}

	/**
	 * Under the selected thread: where its pylon is, and what is wanted of it while it is not there yet, when you and the
	 * agent were last active, and its ID.
	 */
	private detailLine(th: ThreadRow): string {
		const wants = wanting(th.desired, th.pylon.actualState);
		const when = (at: number) => (at === 0 ? "never" : (span(at, this.now()) ?? "now"));
		const facts = [
			`${badge(th.pylon.actualState)[0]} on ${th.pylon.node}`,
			...(wants === null ? [] : [`wants ${wants}`]),
			`you ${when(th.lastHumanActivityAt)}`,
			`agent ${isWorking(th) ? "working" : when(th.lastAgentActivityAt)}`,
			th.id,
		];
		return `     ${this.theme.fg("dim", facts.join(" · "))}`;
	}

	private rowLine(row: PickerRow, selected: boolean, width: number): string {
		const t = this.theme;
		const prefix = selected ? t.fg("accent", "→ ") : "  ";
		switch (row.kind) {
			case "new":
				return ` ${prefix}${t.fg(selected ? "accent" : "muted", "+ New thread")}`;
			case "needs":
				return ` ${t.fg("accent", t.bold("Needs you"))}${t.fg("dim", ` ${row.count}`)}`;
			case "project":
				return ` ▾ ${t.fg("accent", t.bold(row.project))}${t.fg("dim", `  ${this.projects.find((p) => p.id === row.project)?.defaultBranch ?? ""}`)}`;
			case "fold":
				return ` ${prefix}${t.fg("muted", `${row.open ? "▾" : "▸"} ${row.label}`)}`;
			case "thread":
				return this.threadLine(row.thread, selected, row.needs, width);
		}
	}

	private hints(width: number): string {
		const k = (command: Command, description: string) => hint(pickerKeys, command, description);
		const t = this.theme;
		const mode = t.bold(this.filtering ? t.fg("warning", "FILTER") : t.fg("accent", "NORMAL"));
		if (this.help) return modeLine(mode, [rawKeyHint("any key", "closes the help")], width);
		if (this.filtering) return modeLine(mode, [rawKeyHint("type", "filter"), rawKeyHint("↑↓", "navigate"), rawKeyHint("enter", "keep the filter"), rawKeyHint("esc", "clear it")], width);
		return modeLine(mode, [rawKeyHint("j/k", "navigate"), k("open", "open or unfold"), k("new", "new thread"), k("projects", "project"), k("filter", "filter"), k("close", "close"), k("help", "keys")], width);
	}

	render(width: number): string[] {
		const t = this.theme;
		const border = new DynamicBorder();
		const query = this.search.getValue();
		const search = this.filtering ? this.search.render(width - 2).map((l) => ` ${l}`) : query === "" ? [] : [` ${t.fg("muted", `filter: ${query}`)}`];
		const lines = [...border.render(width), "", ` ${t.fg("accent", t.bold("Nexus threads"))}${t.fg("dim", " · ")}${t.fg("muted", scopeLabel(this.scope))}`, ...search, ""];
		if (this.error) lines.push(...wrapTextWithAnsi(this.error, Math.max(10, width - 2)).map((line) => ` ${t.fg("error", line)}`), "");
		if (this.help) {
			const rows = helpLines(pickerKeys);
			const column = Math.max(...rows.map((r) => visibleWidth(r.keys))) + 2;
			lines.push(...rows.map((r) => `   ${t.fg("dim", r.keys.padEnd(column))}${t.fg("muted", r.help)}`));
		} else {
			if (this.rows.length === 0) lines.push(` ${t.fg("muted", "No thread matches.")}`);
			const start = Math.max(0, Math.min(this.selected - Math.floor(visibleRows / 2), this.rows.length - visibleRows));
			for (const [i, row] of this.rows.slice(start, start + visibleRows).entries()) {
				const selected = start + i === this.selected;
				lines.push(this.rowLine(row, selected, width));
				if (selected && row.kind === "thread") lines.push(this.detailLine(row.thread));
			}
			if (this.rows.length > visibleRows) lines.push(` ${t.fg("dim", `(${this.selected + 1}/${this.rows.length})`)}`);
		}
		lines.push("", ` ${this.hints(width - 1)}`, "", ...border.render(width));
		return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		this.search.invalidate();
	}
}
