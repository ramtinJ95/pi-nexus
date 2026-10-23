import type { EntryRenderer, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

/** The custom entry type of everything pi-nexus shows in the chat. Custom entries never reach the model. */
export const noteType = "nexus";

export interface Note {
	title: string;
	body: string;
	error?: boolean;
}

const collapsedLines = 16;

/** Line prefixes of the CLI's entry text, as cli.ts in the nexus repo renders messages. */
function lineColor(line: string): ThemeColor | undefined {
	if (line.startsWith("> ")) return "mdQuote";
	if (line.startsWith("[error]") || line.startsWith("[tool error]")) return "error";
	if (line.startsWith("[tool]") || line.startsWith("[result]") || line.startsWith("[aborted]") || line.startsWith("[earlier")) return "dim";
	return undefined;
}

/** A collapsed note keeps its tail, since the newest lines of a conversation matter most. */
export function noteLines(note: Note, expanded: boolean): { hidden: number; lines: string[] } {
	const lines = note.body === "" ? [] : note.body.split("\n");
	const shown = expanded ? lines : lines.slice(-collapsedLines);
	return { hidden: lines.length - shown.length, lines: shown };
}

export const renderNote: EntryRenderer<Note> = (entry, { expanded }, theme) => {
	const note = entry.data;
	if (note === undefined) return undefined;
	const { hidden, lines } = noteLines(note, expanded);
	const text = [
		`${theme.fg(note.error ? "error" : "accent", "nexus")} ${theme.bold(note.title)}`,
		...(hidden === 0 ? [] : [theme.fg("dim", `${hidden} earlier lines hidden, ctrl+o shows them`)]),
		...lines.map((line) => {
			const color = note.error ? "error" : lineColor(line);
			return color === undefined ? line : theme.fg(color, line);
		}),
	].join("\n");
	const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
	box.addChild(new Text(text, 0, 0));
	return box;
};
