/**
 * Starting a thread, as the dashboard's start dialog: a title, the project, its node and branch, and the first
 * message. Empty node and branch mean the project's defaults. pi's dialog look: borders, an accent title, key hints.
 */
import { CustomEditor, DynamicBorder, getSelectListTheme, rawKeyHint, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { NodeSummary, Project } from "../contract.ts";
import { startHint, type StartForm } from "./model.ts";

type Field = "title" | "project" | "node" | "branch" | "message";
const fields: readonly Field[] = ["title", "project", "node", "branch", "message"];

export interface StartOptions {
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	projects: readonly Project[];
	nodes: readonly NodeSummary[] | Error;
	initial?: { project?: string; title?: string };
	start(form: StartForm): Promise<void>;
	cancel(): void;
}

export class StartFormView implements Component, Focusable {
	private readonly title = new Input({ placeholder: "What should this thread do?" });
	private readonly branch = new Input();
	private readonly message: CustomEditor;
	private field: Field = "title";
	/** -1 while the project asked for is not one there is. */
	private project: number;
	/** 0 is the project's default node, then each node in order. */
	private node = 0;
	private error: string | undefined;
	private starting = false;
	private _focused = false;

	constructor(private readonly o: StartOptions) {
		const t = o.theme;
		const asked = o.initial?.project;
		this.project = asked === undefined ? 0 : o.projects.findIndex((p) => p.id === asked);
		if (this.project < 0 && o.projects.length > 0) this.error = this.unknownProject();
		if (o.initial?.title) this.title.setValue(o.initial.title);
		this.message = new CustomEditor(o.tui, { borderColor: t.getThinkingBorderColor("off"), selectList: getSelectListTheme() }, o.keybindings);
		this.message.onSubmit = (text) => void this.submit(text);
		this.message.onEscape = () => this.cancel();
		this.title.onSubmit = () => this.go(1);
		this.branch.onSubmit = () => this.go(1);
		this.focus();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.focus();
	}

	private focus(): void {
		this.title.focused = this._focused && this.field === "title";
		this.branch.focused = this._focused && this.field === "branch";
		this.message.focused = this._focused && this.field === "message";
	}

	private go(by: number): void {
		this.field = fields[(fields.indexOf(this.field) + by + fields.length) % fields.length]!;
		this.focus();
		this.o.tui.requestRender();
	}

	private unknownProject(): string {
		return `There is no project ${this.o.initial?.project}. Choose one with ←→ in Project.`;
	}

	private nodeNames(): string[] {
		return Array.isArray(this.o.nodes) ? this.o.nodes.map((n) => n.name) : [];
	}

	form(text = this.message.getText()): StartForm {
		const project = this.o.projects[this.project];
		return {
			title: this.title.getValue(),
			project: project?.id ?? "",
			node: this.node === 0 ? "" : (this.nodeNames()[this.node - 1] ?? ""),
			branch: this.branch.getValue(),
			message: text,
		};
	}

	private async submit(text: string): Promise<void> {
		const form = this.form(text);
		if (this.starting) return;
		if (this.o.projects.length === 0) return this.fail("No projects yet, so there is nothing to start a thread on.", text);
		if (form.project === "") return this.fail(this.unknownProject(), text);
		if (form.title.trim() === "" && form.message.trim() === "") return this.fail("A thread needs a title or a first message.", text);
		this.starting = true;
		this.error = undefined;
		this.o.tui.requestRender();
		try {
			await this.o.start(form);
		} catch (err) {
			this.fail(err instanceof Error ? err.message : String(err), text);
		} finally {
			this.starting = false;
			this.o.tui.requestRender();
		}
	}

	/**
	 * A start under way cannot be cancelled: the API may already have the thread, and closing the form would hide it.
	 * Esc works again once the CLI answers.
	 */
	private cancel(): void {
		if (!this.starting) return this.o.cancel();
		this.error = "Starting the thread. Esc closes the form once the CLI answers.";
		this.o.tui.requestRender();
	}

	private fail(message: string, text: string): void {
		this.error = message;
		if (this.message.getText() === "") this.message.setText(text);
		this.o.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "tab")) return this.go(1);
		if (matchesKey(data, "shift+tab")) return this.go(-1);
		if (this.field !== "message" && matchesKey(data, "escape")) return this.cancel();
		const choice = this.field === "project" || this.field === "node";
		if (choice) {
			const count = this.field === "project" ? this.o.projects.length : this.nodeNames().length + 1;
			const by = matchesKey(data, "left") || matchesKey(data, "up") ? -1 : matchesKey(data, "right") || matchesKey(data, "down") ? 1 : 0;
			if (by !== 0 && count > 0) {
				if (this.field === "project") {
					this.project = this.project < 0 ? (by > 0 ? 0 : count - 1) : (this.project + by + count) % count;
					if (this.error === this.unknownProject()) this.error = undefined;
				} else this.node = (this.node + by + count) % count;
			} else if (matchesKey(data, "enter")) return this.go(1);
		} else if (this.field === "title") this.title.handleInput(data);
		else if (this.field === "branch") this.branch.handleInput(data);
		else this.message.handleInput(data);
		this.o.tui.requestRender();
	}

	render(width: number): string[] {
		const t = this.o.theme;
		const label = (field: Field, text: string) => (this.field === field ? t.fg("accent", `→ ${text.padEnd(8)}`) : t.fg("muted", `  ${text.padEnd(8)}`));
		const project = this.o.projects[this.project];
		const form = this.form();
		const choices = (field: Field, items: string[], at: number) =>
			items.map((item, i) => (i === at ? (this.field === field ? t.fg("accent", `[${item}]`) : `[${item}]`) : t.fg("dim", ` ${item} `))).join(" ");
		const nodes = [`${project?.defaultNode ?? "default"} (project default)`, ...this.nodeNames().map((name) => {
			const node = Array.isArray(this.o.nodes) ? this.o.nodes.find((n) => n.name === name) : undefined;
			return node?.state === "offline" ? `${name}, offline` : name;
		})];
		const branch = this.branch.render(Math.max(10, width - 12))[0] ?? "";
		const lines = [
			...new DynamicBorder().render(width),
			"",
			` ${t.fg("accent", t.bold("Start a thread"))}`,
			"",
			` ${label("title", "Title")}${this.title.render(Math.max(10, width - 12))[0] ?? ""}`,
			` ${label("project", "Project")}${this.o.projects.length === 0 ? t.fg("error", "No projects yet.") : choices("project", this.o.projects.map((p) => p.id), this.project)}`,
			...(project ? [`            ${t.fg("dim", project.repoUrl)}`] : []),
			` ${label("node", "Node")}${choices("node", nodes, this.node)}`,
			...(this.o.nodes instanceof Error ? [`            ${t.fg("dim", `Only the project default, since the nodes are unavailable: ${this.o.nodes.message}`)}`] : []),
			` ${label("branch", "Branch")}${this.branch.getValue() === "" && this.field !== "branch" ? t.fg("dim", project?.defaultBranch ?? "") : branch}`,
			` ${label("message", "Message")}`,
			...this.message.render(width),
			` ${t.fg("muted", startHint(project, form))}`,
			...(this.error ? wrapTextWithAnsi(this.error, width - 2).map((l) => ` ${t.fg("error", l)}`) : []),
			...(this.starting ? [` ${t.fg("muted", "Starting...")}`] : []),
			"",
			` ${[rawKeyHint("tab", "next field"), rawKeyHint("←→", "choose"), rawKeyHint("enter", "start, in the message"), rawKeyHint("esc", "cancel")].join("  ")}`,
			"",
			...new DynamicBorder().render(width),
		];
		return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		this.title.invalidate();
		this.branch.invalidate();
		this.message.invalidate();
	}
}
