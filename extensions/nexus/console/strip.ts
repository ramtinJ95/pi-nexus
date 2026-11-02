/**
 * The strip above pi's editor: one notice when something in Nexus asks for you, as the control plane's attention
 * says, and nothing while threads only work. It names the most urgent thread with what it asks, or counts the threads
 * that need you and those with a new reply, as the status line does, in the look of the most urgent, always on one
 * row. Until the threads are first read, it says why they could not be. It shows from the session's start, and
 * `/nexus strip off` hides it. Scoped to one project, it names the project after `nexus` while there is room.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { toneColor, type Notice } from "./model.ts";

export type StripShows = { kind: "notice"; notice: Notice } | { kind: "failure"; message: string };

/** The least a thread's title takes beside the project's name; narrower, the name goes. */
const leastTitle = 8;

/** Several threads that ask for the person, counted in the status line's words, widest first. */
function counts(acts: number, reads: number): string[] {
	const needs = (threads: boolean) => `${acts} ${threads ? (acts === 1 ? "thread needs" : "threads need") : acts === 1 ? "needs" : "need"} you`;
	if (acts === 0) return [`${reads} new replies`, `${reads} new`];
	if (reads === 0) return [needs(true), needs(false)];
	return [`${needs(true)} · ${reads} new`, `${needs(false)} · ${reads} new`, needs(false)];
}

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
		const { top, look, acts, reads } = this.shows.notice;
		const color = toneColor[look.tone];
		const room = (named: boolean) => width - visibleWidth(head(named)) - 2 - visibleWidth(look.glyph) - 1;
		let line: string;
		if (acts + reads === 1) {
			const word = visibleWidth(look.word) + 2;
			const named = room(true) - word >= leastTitle;
			line = `${head(named)}  ${t.fg(color, look.glyph)} ${truncateToWidth(top.title, Math.max(1, room(named) - word), "…")}  ${t.fg(color, look.word)}`;
		} else {
			const many = counts(acts, reads);
			const named = room(true) >= visibleWidth(many[0]!);
			line = `${head(named)}  ${t.fg(color, look.glyph)} ${t.bold(many.find((text) => visibleWidth(text) <= room(named)) ?? many.at(-1)!)}`;
		}
		return [truncateToWidth(line, width)];
	}

	invalidate(): void {}
}
