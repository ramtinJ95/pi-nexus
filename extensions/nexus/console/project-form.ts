/**
 * Adding a project, from New project in the project picker: its ID, repo URL, node and branch, which `nexus project
 * add` takes. pi's dialog look, as the start form's. A failure shows the CLI's message as it is, since it names what
 * to fix, such as a project that exists or an ID, URL or node that is not valid.
 */
import { DynamicBorder, rawKeyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { NodeSummary } from "../contract.ts";

type Field = "id" | "repo" | "node" | "branch";
const fields: readonly Field[] = ["id", "repo", "node", "branch"];
const defaultBranch = "main";
const placeholders: Readonly<Record<Exclude<Field, "node">, string>> = {
	id: "lowercase letters, digits and dashes",
	repo: "git@github.com:you/repo.git or https://...",
	branch: defaultBranch,
};

export interface ProjectForm {
	id: string;
	repoUrl: string;
	node: string;
	branch: string;
}

export interface ProjectFormOptions {
	tui: TUI;
	theme: Theme;
	nodes: readonly NodeSummary[] | Error;
	add(form: ProjectForm): Promise<void>;
	cancel(): void;
}

export class ProjectFormView implements Component, Focusable {
	private readonly id: Input;
	private readonly repo: Input;
	private readonly branch: Input;
	private field: Field = "id";
	private node: number;
	private error: string | undefined;
	private adding = false;
	private _focused = false;

	constructor(private readonly o: ProjectFormOptions) {
		const input = (field: keyof typeof placeholders) => new Input({ placeholder: placeholders[field], placeholderStyle: (text) => o.theme.fg("dim", text) });
		this.id = input("id");
		this.repo = input("repo");
		this.branch = input("branch");
		for (const input of [this.id, this.repo]) input.onSubmit = () => this.go(1);
		this.branch.onSubmit = () => void this.submit();
		// The first online node, as a new project's pylons boot there.
		this.node = Math.max(0, this.nodes().findIndex((n) => n.state === "online"));
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
		this.id.focused = this._focused && this.field === "id";
		this.repo.focused = this._focused && this.field === "repo";
		this.branch.focused = this._focused && this.field === "branch";
	}

	private nodes(): readonly NodeSummary[] {
		return Array.isArray(this.o.nodes) ? this.o.nodes : [];
	}

	private go(by: number): void {
		this.field = fields[(fields.indexOf(this.field) + by + fields.length) % fields.length]!;
		this.focus();
		this.o.tui.requestRender();
	}

	/** Why no node can be chosen, or undefined while one can. */
	private noNode(): string | undefined {
		if (this.o.nodes instanceof Error) return `The nodes could not be read, so there is no node to add the project on: ${this.o.nodes.message}`;
		if (this.o.nodes.length === 0) return "No nodes yet, so there is no node to add the project on.";
		return undefined;
	}

	form(): ProjectForm {
		return {
			id: this.id.getValue().trim(),
			repoUrl: this.repo.getValue().trim(),
			node: this.nodes()[this.node]?.name ?? "",
			branch: this.branch.getValue().trim() || defaultBranch,
		};
	}

	private async submit(): Promise<void> {
		if (this.adding) return;
		const form = this.form();
		const missing = form.id === "" ? "A project needs an ID." : form.repoUrl === "" ? "A project needs a repo URL." : this.noNode();
		if (missing !== undefined) {
			this.error = missing;
			return this.o.tui.requestRender();
		}
		this.adding = true;
		this.error = undefined;
		this.o.tui.requestRender();
		try {
			await this.o.add(form);
		} catch (err) {
			this.error = err instanceof Error ? err.message : String(err);
		} finally {
			this.adding = false;
			this.o.tui.requestRender();
		}
	}

	/** An add under way cannot be cancelled: the API may already have the project, and closing the form would hide it. */
	private cancel(): void {
		if (!this.adding) return this.o.cancel();
		this.error = "Adding the project. Esc closes the form once the CLI answers.";
		this.o.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "tab")) return this.go(1);
		if (matchesKey(data, "shift+tab")) return this.go(-1);
		if (matchesKey(data, "escape")) return this.cancel();
		if (this.field === "node") {
			const count = this.nodes().length;
			const by = matchesKey(data, "left") || matchesKey(data, "up") ? -1 : matchesKey(data, "right") || matchesKey(data, "down") ? 1 : 0;
			if (by !== 0 && count > 0) this.node = (this.node + by + count) % count;
			else if (matchesKey(data, "enter")) return this.go(1);
		} else if (this.field === "id") this.id.handleInput(data);
		else if (this.field === "repo") this.repo.handleInput(data);
		else this.branch.handleInput(data);
		this.o.tui.requestRender();
	}

	render(width: number): string[] {
		const t = this.o.theme;
		const label = (field: Field, text: string) => (this.field === field ? t.fg("accent", `→ ${text.padEnd(9)}`) : t.fg("muted", `  ${text.padEnd(9)}`));
		// An empty field away from the cursor shows its placeholder without the cursor Input draws on it.
		const input = (field: keyof typeof placeholders) => {
			const shown = this[field];
			return shown.focused || shown.getValue() !== "" ? (shown.render(Math.max(10, width - 13))[0] ?? "") : `> ${t.fg("dim", placeholders[field])}`;
		};
		const nodes = this.nodes().map((n, i) => {
			const name = n.state === "offline" ? `${n.name}, offline` : n.name;
			return i === this.node ? (this.field === "node" ? t.fg("accent", `[${name}]`) : `[${name}]`) : t.fg("dim", ` ${name} `);
		});
		const noNode = this.noNode();
		const lines = [
			...new DynamicBorder().render(width),
			"",
			` ${t.fg("accent", t.bold("Add a project"))}`,
			"",
			` ${label("id", "ID")}${input("id")}`,
			` ${label("repo", "Repo URL")}${input("repo")}`,
			` ${label("node", "Node")}${noNode === undefined ? nodes.join(" ") : ""}`,
			...(noNode === undefined ? [] : wrapTextWithAnsi(noNode, width - 2).map((l) => ` ${t.fg("error", l)}`)),
			` ${label("branch", "Branch")}${input("branch")}`,
			"",
			` ${t.fg("muted", "Its threads' pylons boot on the node and check out the branch, unless a thread asks for others.")}`,
			...(this.error ? wrapTextWithAnsi(this.error, width - 2).map((l) => ` ${t.fg("error", l)}`) : []),
			...(this.adding ? [` ${t.fg("muted", "Adding...")}`] : []),
			"",
			` ${[rawKeyHint("tab", "next field"), rawKeyHint("←→", "choose the node"), rawKeyHint("enter", "next, or add from Branch"), rawKeyHint("esc", "cancel")].join("  ")}`,
			"",
			...new DynamicBorder().render(width),
		];
		return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		this.id.invalidate();
		this.repo.invalidate();
		this.branch.invalidate();
	}
}
