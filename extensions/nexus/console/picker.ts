/**
 * The thread picker, in pi's selector look: threads grouped by project, open ones first, the archived and deleted
 * ones folded, with the dashboard's overview columns. Typing filters, as in pi's session picker.
 */
import { DynamicBorder, rawKeyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { Project, ThreadRow } from "../contract.ts";
import { lastActivityAt } from "../thread.ts";
import { ago, badge, groups, pickerRows, span, threadState, toneColor, type Group, type PickerRow, type Tone } from "./model.ts";

export type PickerEnd = { kind: "open"; thread: string } | { kind: "new"; project?: string } | { kind: "close" };

const selectable = (row: PickerRow) => row.kind === "thread" || row.kind === "fold" || row.kind === "new";
const visibleRows = 14;

export class Picker implements Component, Focusable {
	private readonly search = new Input();
	private groups: Group[] = [];
	private readonly unfolded = new Set<string>();
	private rows: PickerRow[] = [];
	private selected = 0;
	private error: string | undefined;
	private _focused = false;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly done: (end: PickerEnd) => void,
		private readonly now: () => number = Date.now,
	) {}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.search.focused = value;
	}

	setThreads(threads: readonly ThreadRow[], projects: readonly Project[]): void {
		const current = this.rows[this.selected];
		this.groups = groups(threads, projects);
		this.error = undefined;
		this.layout();
		// The same thread stays selected across a refresh.
		if (current?.kind === "thread") {
			const again = this.rows.findIndex((r) => r.kind === "thread" && r.thread.id === current.thread.id);
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

	private move(by: number): void {
		for (let i = this.selected + by; i >= 0 && i < this.rows.length; i += by) {
			if (selectable(this.rows[i]!)) {
				this.selected = i;
				return;
			}
		}
	}

	handleInput(data: string): void {
		const row = this.rows[this.selected];
		if (matchesKey(data, "up")) this.move(-1);
		else if (matchesKey(data, "down")) this.move(1);
		else if (matchesKey(data, "ctrl+n")) return this.done({ kind: "new", ...(this.projectOf(row) ? { project: this.projectOf(row)! } : {}) });
		else if (matchesKey(data, "escape")) {
			if (this.search.getValue() === "") return this.done({ kind: "close" });
			this.search.setValue("");
			this.layout();
		} else if (matchesKey(data, "enter")) {
			if (row?.kind === "thread") return this.done({ kind: "open", thread: row.thread.id });
			if (row?.kind === "new") return this.done({ kind: "new" });
			if (row?.kind === "fold") {
				if (this.unfolded.has(row.project)) this.unfolded.delete(row.project);
				else this.unfolded.add(row.project);
				this.layout();
			}
		} else {
			this.search.handleInput(data);
			this.selected = 0;
			this.layout();
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
		const level = [0, 1, 2].find((l) => width - used(l) >= title + 6) ?? 2;
		const widths = widthsAt(level);
		const out = new Map<ThreadRow, string>();
		threads.forEach((th, i) => {
			const selected = this.rows[this.selected]?.kind === "thread" && (this.rows[this.selected] as { thread: ThreadRow }).thread === th;
			const right = cells[i]!.level[level]!.flatMap((cell, c) => (widths[c] === 0 ? [] : [cell.padEnd(widths[c]!)])).join("  ").trimEnd();
			const prefix = selected ? t.fg("accent", "→ ") : "  ";
			const left = ` ${prefix}${t.fg(toneColor[cells[i]!.tone], "●")} ${selected ? t.fg("accent", th.title) : th.title}`;
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
				return ` ${t.fg("accent", t.bold(row.project))}${t.fg("dim", ` ${row.count}`)}`;
			case "fold":
				return ` ${prefix}${t.fg("muted", `${row.open ? "▾" : "▸"} ${row.label}`)}`;
			case "thread":
				return table.get(row.thread)!;
		}
	}

	render(width: number): string[] {
		const t = this.theme;
		const border = new DynamicBorder();
		const lines = [...border.render(width), "", ` ${t.fg("accent", t.bold("Nexus threads"))}`, ...this.search.render(width - 2).map((l) => ` ${l}`), ""];
		if (this.error) lines.push(...wrapTextWithAnsi(this.error, Math.max(10, width - 2)).map((line) => ` ${t.fg("error", line)}`), "");
		if (this.rows.length === 0) lines.push(` ${t.fg("muted", "No thread matches.")}`);
		const start = Math.max(0, Math.min(this.selected - Math.floor(visibleRows / 2), this.rows.length - visibleRows));
		const table = this.table(width);
		for (const [i, row] of this.rows.slice(start, start + visibleRows).entries()) lines.push(this.rowLine(row, start + i === this.selected, table));
		if (this.rows.length > visibleRows) lines.push(` ${t.fg("dim", `(${this.selected + 1}/${this.rows.length})`)}`);
		lines.push(
			"",
			` ${[rawKeyHint("↑↓", "navigate"), rawKeyHint("enter", "open or unfold"), rawKeyHint("ctrl+n", "new thread"), rawKeyHint("type", "filter"), rawKeyHint("esc", "close")].join("  ")}`,
			"",
			...border.render(width),
		);
		return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		this.search.invalidate();
	}
}
