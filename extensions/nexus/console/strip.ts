/**
 * The strip above pi's editor: the threads that need you, then those with news since you last looked, then those
 * whose agent works, with how long ago the message it answers came. It shows while the session follows Nexus, and
 * `/nexus strip off` hides it.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { span, type Chip } from "./model.ts";

const looks: Readonly<Record<Chip["kind"], { label: string; color: "warning" | "accent" | "muted" }>> = {
	"needs-you": { label: "needs you", color: "warning" },
	new: { label: "new reply", color: "accent" },
	working: { label: "working", color: "muted" },
};

export class Strip implements Component {
	constructor(
		private readonly theme: Theme,
		private readonly chips: readonly Chip[],
		private readonly now: number,
	) {}

	render(width: number): string[] {
		const t = this.theme;
		const shown = this.chips.map(({ thread, kind }) => {
			const look = looks[kind];
			// A thread no human wrote to has no message to time the work from, as ago() reads 0 as never.
			const since = kind === "working" && thread.lastHumanActivityAt !== 0 ? ` ${span(thread.lastHumanActivityAt, this.now) ?? "now"}` : "";
			return `${t.fg(look.color, "●")} ${thread.title} ${t.fg(look.color, `${look.label}${since}`)}`;
		});
		const head = t.fg("dim", "nexus ");
		let line = head;
		for (const [i, chip] of shown.entries()) {
			const more = shown.length - i - 1;
			const next = `${line}${i === 0 ? "" : t.fg("dim", "  ·  ")}${chip}`;
			const tail = more > 0 ? t.fg("dim", `  +${more} more`) : "";
			if (visibleWidth(next + tail) > width && i > 0) return [truncateToWidth(`${line}${t.fg("dim", `  +${shown.length - i} more`)}`, width)];
			line = next;
		}
		return [truncateToWidth(line, width)];
	}

	invalidate(): void {}
}
