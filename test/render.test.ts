import { describe, expect, test } from "bun:test";
import { renderNote, type Note } from "../extensions/nexus/render.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => `*${text}*`,
};

function render(note: Note, expanded: boolean, width = 80): string[] {
	const component = renderNote({ type: "custom", customType: "nexus", data: note } as never, { expanded }, theme as never)!;
	return component.render(width).map((line) => line.trimEnd()).filter((line) => line !== "");
}

const body = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");

describe("nexus notes", () => {
	test("a collapsed note shows its newest lines and counts the rest", () => {
		const lines = render({ title: "th-1", body }, false);
		expect(lines[0]).toContain("*th-1*");
		expect(lines[1]).toContain("14 earlier lines hidden");
		expect(lines.slice(2).map((l) => l.trim())).toEqual(Array.from({ length: 16 }, (_, i) => `line ${i + 15}`));
	});

	test("an expanded note shows every line", () => {
		const lines = render({ title: "th-1", body }, true);
		expect(lines).toHaveLength(31);
		expect(lines.some((l) => l.includes("hidden"))).toBe(false);
	});

	test("lines are colored by what they render", () => {
		const lines = render({ title: "th-1", body: "> asked\n[tool] bash {}\n[error] The model failed: x\nanswer" }, false);
		expect(lines.slice(1).map((l) => l.trim())).toEqual(["<mdQuote>> asked</mdQuote>", "<dim>[tool] bash {}</dim>", "<error>[error] The model failed: x</error>", "answer"]);
	});

	test("an error note is red in its label and its body", () => {
		const lines = render({ title: "th-1", body: "Nexus is unreachable: proxy down. Still watching.", error: true }, false);
		expect(lines[0]).toContain("<error>nexus</error>");
		expect(lines[1]!.trim()).toBe("<error>Nexus is unreachable: proxy down. Still watching.</error>");
	});

	test("long lines wrap to the width", () => {
		const real = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t };
		const component = renderNote({ type: "custom", customType: "nexus", data: { title: "t", body: "word ".repeat(100) } } as never, { expanded: false }, real as never)!;
		for (const line of component.render(40)) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
	});
});
