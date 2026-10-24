/**
 * The project picker, which `p` opens from the thread picker or a thread: every project, each project with its repo
 * URL or `scratch`, and a new one. Choosing one scopes the thread picker, the strip and the status line to it. pi's
 * selector look, and the vim keys of the console's other menus.
 */
import { DynamicBorder, rawKeyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { Project } from "../contract.ts";
import { KeyReader, type Binding } from "./keys.ts";
import { repoOf } from "./model.ts";

/** `scope` shows `project`, or every project for null; `new` opens the form that adds one. */
export type ProjectEnd = { kind: "scope"; project: string | null } | { kind: "new" } | { kind: "cancel" };

type Row = { kind: "all" } | { kind: "project"; project: Project } | { kind: "new" };
const visibleRows = 12;

type Command = "down" | "up" | "top" | "bottom" | "choose" | "cancel";
const projectKeys: readonly Binding<Command>[] = [
	{ keys: ["j", "down"], command: "down", help: "next" },
	{ keys: ["k", "up"], command: "up", help: "previous" },
	{ keys: ["gg", "home"], command: "top", help: "the first row" },
	{ keys: ["G", "ge", "end"], command: "bottom", help: "the last row" },
	{ keys: ["enter", "o"], command: "choose", help: "choose" },
	{ keys: ["escape", "q"], command: "cancel", help: "cancel" },
];

export class ProjectPicker implements Component, Focusable {
	focused = false;
	private readonly keys = new KeyReader(projectKeys);
	/** Undefined until the projects load. */
	private projects: readonly Project[] | undefined;
	private error: string | undefined;
	private selected = 0;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly done: (end: ProjectEnd) => void,
		/** The project shown now, or null for every project, which starts selected. */
		private readonly current: string | null,
	) {}

	setProjects(projects: readonly Project[]): void {
		const onNew = this.rows()[this.selected]?.kind === "new";
		this.projects = projects;
		this.error = undefined;
		// A row moved to while the projects loaded stays selected. Otherwise the project shown now is.
		const rows = this.rows();
		const current = rows.findIndex((r) => r.kind === "project" && r.project.id === this.current);
		if (onNew) this.selected = rows.length - 1;
		else if (this.selected === 0 && current !== -1) this.selected = current;
		this.tui.requestRender();
	}

	setError(message: string): void {
		this.error = message;
		this.tui.requestRender();
	}

	private rows(): Row[] {
		return [{ kind: "all" }, ...(this.projects ?? []).map((project): Row => ({ kind: "project", project })), { kind: "new" }];
	}

	handleInput(data: string): void {
		const rows = this.rows();
		switch (this.keys.read(data)) {
			case "down":
				this.selected = Math.min(rows.length - 1, this.selected + 1);
				break;
			case "up":
				this.selected = Math.max(0, this.selected - 1);
				break;
			case "top":
				this.selected = 0;
				break;
			case "bottom":
				this.selected = rows.length - 1;
				break;
			case "choose": {
				const row = rows[this.selected]!;
				return this.done(row.kind === "new" ? { kind: "new" } : { kind: "scope", project: row.kind === "all" ? null : row.project.id });
			}
			case "cancel":
				return this.done({ kind: "cancel" });
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const t = this.theme;
		const rows = this.rows();
		const name = (row: Row) => (row.kind === "all" ? "All projects" : row.kind === "new" ? "+ New project…" : row.project.id);
		const column = Math.max(...rows.map((r) => visibleWidth(name(r)))) + 2;
		const lines = [...new DynamicBorder().render(width), "", ` ${t.fg("accent", t.bold("Projects"))}`, ""];
		if (this.error) lines.push(...wrapTextWithAnsi(this.error, Math.max(10, width - 2)).map((line) => ` ${t.fg("error", line)}`), "");
		// Many projects scroll, as the thread picker's rows do, so the selected one stays in sight.
		const start = Math.max(0, Math.min(this.selected - Math.floor(visibleRows / 2), rows.length - visibleRows));
		for (const [i, row] of rows.slice(start, start + visibleRows).map((r, at) => [start + at, r] as const)) {
			const selected = i === this.selected;
			const prefix = selected ? t.fg("accent", "→ ") : "  ";
			const label = row.kind === "new" ? t.fg(selected ? "accent" : "muted", name(row)) : selected ? t.fg("accent", name(row)) : name(row);
			const current = (row.kind === "all" && this.current === null) || (row.kind === "project" && row.project.id === this.current);
			const detail = [row.kind === "project" ? repoOf(row.project) : "", current ? "current" : ""].filter(Boolean).join("  ");
			lines.push(` ${prefix}${label}${detail === "" ? "" : `${" ".repeat(column - visibleWidth(name(row)))}${t.fg("dim", detail)}`}`);
			if (row.kind === "all" && this.projects === undefined && this.error === undefined) lines.push(`   ${t.fg("muted", "Reading the projects...")}`);
		}
		if (rows.length > visibleRows) lines.push(` ${t.fg("dim", `(${this.selected + 1}/${rows.length})`)}`);
		const hints = [rawKeyHint("j/k", "move"), rawKeyHint("gg/ge", "first or last"), rawKeyHint("enter", "choose"), rawKeyHint("esc", "cancel")];
		lines.push("", ` ${hints.join("  ")}`, "", ...new DynamicBorder().render(width));
		return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {}
}
