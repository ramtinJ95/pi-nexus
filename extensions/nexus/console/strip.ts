/**
 * The strip above pi's editor: one notice when something in Nexus asks for you, as the control plane's attention
 * says, and nothing while threads only work. It names the most urgent thread with what it asks, or counts the threads
 * that ask, in the look of the most urgent, always on one row. Until the threads are first read, it says why they
 * could not be. It shows from the session's start, and `/nexus strip off` hides it. Scoped to one project, it names
 * the project after `nexus` while there is room.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { toneColor, type Notice } from "./model.ts";

export type StripShows = { kind: "notice"; notice: Notice } | { kind: "failure"; message: string };

/** The least a thread's title takes beside the project's name; narrower, the name goes. */
const leastTitle = 8;

export class Strip implements Component {
	constructor(
		private readonly theme: Theme,
		private readonly shows: StripShows,
		private readonly project: string | null = null,
	) {}

	render(width: number): string[] {
		const t = this.theme;
		const head = (named: boolean) => t.fg("dim", named && this.project !== null ? `nexus · ${this.project}` : "nexus");
		if (this.shows.kind === "failure") return [truncateToWidth(`${head(true)}  ${t.fg("error", this.shows.message)}`, width)];
		const { top, look, count } = this.shows.notice;
		const color = toneColor[look.tone];
		const room = (named: boolean) => width - visibleWidth(head(named)) - 2 - visibleWidth(look.glyph) - 1;
		let line: string;
		if (count === 1) {
			const word = visibleWidth(look.word) + 2;
			const named = room(true) - word >= leastTitle;
			line = `${head(named)}  ${t.fg(color, look.glyph)} ${truncateToWidth(top.title, Math.max(1, room(named) - word), "…")}  ${t.fg(color, look.word)}`;
		} else {
			const many = [`${count} threads need you`, `${count} need you`];
			const named = room(true) >= visibleWidth(many[0]!);
			line = `${head(named)}  ${t.fg(color, look.glyph)} ${t.bold(many.find((text) => visibleWidth(text) <= room(named)) ?? many[1]!)}`;
		}
		return [truncateToWidth(line, width)];
	}

	invalidate(): void {}
}
