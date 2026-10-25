import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { sessionLines } from "../extensions/nexus/console/inspector.ts";
import { noSessionChanges } from "../extensions/nexus/console/model.ts";
import type { Session } from "../extensions/nexus/contract.ts";
import { detail, piTheme, plain } from "./console-fixture.ts";

test.each([
	["claude-code", "review", "plan"],
	["a-long-custom-harness", "修正確認", "修正"],
])("Sessions aligns %s and mixed titles, including an untitled row", (harness, title, shorter) => {
	const sessions: Session[] = [
		{ id: "%1", state: "running", message: null, harness, title, status: "idle", herdrPane: "%1", harnessSessionId: "first" },
		{ id: "%2", state: "running", message: null, harness: "pi", title: shorter, status: "idle", herdrPane: "%2", harnessSessionId: "second" },
		{ id: "%3", state: "running", message: null, harness: "shell", status: "idle", herdrPane: "%3", harnessSessionId: "third" },
	];
	const render = (width: number) => sessionLines(piTheme(), detail, sessions, noSessionChanges(), 0, width, "nexus");
	const { lines, rows } = render(120);
	const shown = rows.map(([first]) => plain([lines[first]!]));
	const column = (line: string, text: string) => visibleWidth(line.slice(0, line.indexOf(text)));
	expect(column(shown[0]!, title)).toBe(column(shown[1]!, shorter));
	for (const token of ["●", "idle", "%", "session"]) {
		const columns = shown.map((line) => column(line, token));
		expect(columns).toEqual([columns[0]!, columns[0]!, columns[0]!]);
	}
	const harnessWidth = Math.max(...[harness === "claude-code" ? "Claude Code" : harness, "pi", "Shell"].map(visibleWidth));
	expect(column(shown[0]!, title)).toBe(3 + harnessWidth + 2);
	expect(column(shown[2]!, "●")).toBe(3 + harnessWidth + 2 + visibleWidth(title) + 2);
	for (const width of [1, 12, 24, 40]) {
		const narrow = render(width);
		expect(narrow.rows).toHaveLength(3);
		for (const line of narrow.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	}
});
