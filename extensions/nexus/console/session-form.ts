/**
 * Opening a session in the pylon, from n in a thread view: the harness, Claude Code unless another is chosen, and an
 * optional title, which `nexus session open` takes. It sits in the composer's place, as the actions menu does.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, type Component, type Focusable } from "@earendil-works/pi-tui";
import { harnesses } from "../contract.ts";
import { harnessLabel } from "./model.ts";

type Field = "harness" | "title";

export class SessionForm implements Component, Focusable {
	private readonly title = new Input();
	private field: Field = "harness";
	private harness = 0;
	private _focused = false;

	constructor(
		private readonly theme: Theme,
		/** `title` is undefined when left empty, for the CLI's default, the harness's name. */
		private readonly open: (harness: string, title: string | undefined) => void,
		private readonly cancel: () => void,
	) {
		this.title.onSubmit = () => this.submit();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.title.focused = value && this.field === "title";
	}

	private go(field: Field): void {
		this.field = field;
		this.focused = this._focused;
	}

	private submit(): void {
		this.open(harnesses[this.harness]!, this.title.getValue().trim() || undefined);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) return this.cancel();
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab") || matchesKey(data, "up") || matchesKey(data, "down")) {
			return this.go(this.field === "harness" ? "title" : "harness");
		}
		if (this.field === "title") return this.title.handleInput(data);
		const by = matchesKey(data, "left") || data === "h" ? -1 : matchesKey(data, "right") || data === "l" ? 1 : 0;
		if (by !== 0) this.harness = (this.harness + by + harnesses.length) % harnesses.length;
		// The title is optional, so Enter opens from either field.
		else if (matchesKey(data, "enter")) this.submit();
	}

	render(width: number): string[] {
		const t = this.theme;
		const label = (field: Field, text: string) => (this.field === field ? t.fg("accent", `→ ${text.padEnd(9)}`) : t.fg("muted", `  ${text.padEnd(9)}`));
		const choices = harnesses.map((h, i) => {
			const name = harnessLabel[h] ?? h;
			return i === this.harness ? (this.field === "harness" ? t.fg("accent", `[${name}]`) : `[${name}]`) : t.fg("dim", ` ${name} `);
		});
		// An empty title away from the cursor shows what it defaults to, without the cursor Input draws.
		const title =
			this.title.focused || this.title.getValue() !== ""
				? (this.title.render(Math.max(10, width - 12))[0] ?? "")
				: `> ${t.fg("dim", `optional; ${harnesses[this.harness]} when empty`)}`;
		return [
			` ${t.fg("accent", t.bold("Open a session in the pylon"))}`,
			` ${label("harness", "Harness")}${choices.join(" ")}`,
			` ${label("title", "Title")}${title}`,
		].map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		this.title.invalidate();
	}
}
