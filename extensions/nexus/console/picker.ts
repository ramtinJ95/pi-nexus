/**
 * The thread picker, in pi's selector look: threads grouped by project, open ones first, the archived and deleted
 * ones folded, with the dashboard's overview columns. It shows the project chosen with p, or every project. A thread whose pylon failed says it needs you, and one whose
 * agent did something since you last looked says it is new.
 *
 * Its keys are vim's, as the thread view's are: j and k move, / filters as pi's session picker does when you type,
 * and Enter accepts the filter.
 */
import { DynamicBorder, rawKeyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { Project, ThreadRow } from "../contract.ts";
import { inScope, scopeLabel } from "../scope.ts";
import { lastActivityAt } from "../thread.ts";
import { helpLines, hint, KeyReader, type Binding } from "./keys.ts";
import { ago, attention, badge, groups, pickerRows, span, threadState, toneColor, type Group, type Marks, type PickerRow, type Tone } from "./model.ts";

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
	private groups: Group[] = [];
	private marks: Marks = { seen: { since: 0, threads: {} }, parked: new Map() };
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
	setThreads(threads: readonly ThreadRow[], projects: readonly Project[], marks: Marks, scope: string | null): void {
		const current = this.rows[this.selected];
		const keep = this.at ?? (current?.kind === "thread" ? current.thread.id : undefined);
		this.at = undefined;
		this.scope = scope;
		this.projects = projects;
		this.groups = groups(inScope(threads, scope), scope === null ? projects : projects.filter((p) => p.id === scope));
		this.marks = marks;
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
		this.rows = pickerRows(this.groups, this.unfolded, this.search.getValue());
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
					if (this.unfolded.has(row.project)) this.unfolded.delete(row.project);
					else this.unfolded.add(row.project);
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

	/** A thread's overview columns, fullest first: state, wanted, observed, node, human, agent, last active. */
	private cells(th: ThreadRow): { level: string[][]; tone: Tone } {
		const [label, tone] = threadState(th, th.pylon.actualState);
		const desired = `wanted ${th.desired}`;
		const pylon = [badge(th.pylon.actualState)[0], th.pylon.node];
		const human = `human ${ago(th.lastHumanActivityAt, this.now())}`;
		const agent = `agent ${th.agentTurnRunning ? "turn running" : ago(th.lastAgentActivityAt, this.now())}`;
		const at = span(lastActivityAt(th), this.now()) ?? "now";
		return { tone, level: [[label, desired, ...pylon, human, agent, at], [label, desired, ...pylon, at], [label, at]] };
	}

	/** What a thread wants of the person, after its title. */
	private marker(th: ThreadRow): string {
		const a = attention(th, this.marks);
		return a === "needs-you" ? ` ${this.theme.fg("warning", "needs you")}` : a === "new" ? ` ${this.theme.fg("accent", "new")}` : "";
	}

	/**
	 * The thread rows as a table. Every row shows the same columns, dropped from the right while the longest title,
	 * up to 40 columns, would not fit beside them.
	 */
	private table(width: number): Map<ThreadRow, string> {
		const t = this.theme;
		const threads = this.rows.flatMap((r) => (r.kind === "thread" ? [r.thread] : []));
		const cells = threads.map((th) => this.cells(th));
		const title = Math.min(40, Math.max(0, ...threads.map((th) => visibleWidth(th.title))));
		const widthsAt = (level: number) =>
			cells[0]?.level[level]!.map((_, i) => Math.max(...cells.map((c) => visibleWidth(c.level[level]![i]!)))) ?? [];
		const used = (level: number) => widthsAt(level).reduce((sum, w) => sum + (w === 0 ? 0 : w + 2), 0);
		const level = [0, 1, 2].find((l) => width - used(l) >= title + 16) ?? 2;
		const widths = widthsAt(level);
		const out = new Map<ThreadRow, string>();
		threads.forEach((th, i) => {
			const selected = this.rows[this.selected]?.kind === "thread" && (this.rows[this.selected] as { thread: ThreadRow }).thread === th;
			// Keep every row the same width; only the final activity age is right-aligned within its column.
			const right = cells[i]!.level[level]!.flatMap((cell, c) => (widths[c] === 0 ? [] : [c === widths.length - 1 ? cell.padStart(widths[c]!) : cell.padEnd(widths[c]!)])).join("  ");
			const prefix = selected ? t.fg("accent", "→ ") : "  ";
			const left = ` ${prefix}${t.fg(toneColor[cells[i]!.tone], "●")} ${selected ? t.fg("accent", th.title) : th.title}${this.marker(th)}`;
			const shownLeft = truncateToWidth(left, Math.max(10, width - visibleWidth(right) - 2));
			out.set(th, `${shownLeft}${" ".repeat(Math.max(2, width - visibleWidth(shownLeft) - visibleWidth(right)))}${t.fg("dim", right)}`);
		});
		return out;
	}

	private rowLine(row: PickerRow, selected: boolean, table: Map<ThreadRow, string>): string {
		const t = this.theme;
		const prefix = selected ? t.fg("accent", "→ ") : "  ";
		switch (row.kind) {
			case "new":
				return ` ${prefix}${t.fg(selected ? "accent" : "muted", "+ New thread")}`;
			case "project":
				return ` ▾ ${t.fg("accent", t.bold(row.project))}${t.fg("dim", `  ${this.projects.find((p) => p.id === row.project)?.defaultBranch ?? ""}`)}`;
			case "fold":
				return ` ${prefix}${t.fg("muted", `${row.open ? "▾" : "▸"} ${row.label}`)}`;
			case "thread":
				return table.get(row.thread)!;
		}
	}

	private hints(): string {
		const k = (command: Command, description: string) => hint(pickerKeys, command, description);
		const t = this.theme;
		const mode = t.bold(this.filtering ? t.fg("warning", "FILTER") : t.fg("accent", "NORMAL"));
		if (this.help) return `${mode}  ${rawKeyHint("any key", "closes the help")}`;
		if (this.filtering) return [mode, rawKeyHint("type", "filter"), rawKeyHint("↑↓", "navigate"), rawKeyHint("enter", "keep the filter"), rawKeyHint("esc", "clear it")].join("  ");
		return [mode, rawKeyHint("j/k", "navigate"), k("open", "open or unfold"), k("new", "new thread"), k("projects", "project"), k("filter", "filter"), k("help", "keys"), k("close", "close")].join("  ");
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
			const table = this.table(width);
			for (const [i, row] of this.rows.slice(start, start + visibleRows).entries()) lines.push(this.rowLine(row, start + i === this.selected, table));
			if (this.rows.length > visibleRows) lines.push(` ${t.fg("dim", `(${this.selected + 1}/${this.rows.length})`)}`);
		}
		lines.push("", ` ${this.hints()}`, "", ...border.render(width));
		return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		this.search.invalidate();
	}
}
