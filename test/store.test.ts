import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { settingsFile, viewedFile } from "../extensions/nexus/store.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function file(name = "viewed.json") {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-nexus-store-"));
	dirs.push(dir);
	return path.join(dir, "pi-nexus", name);
}

describe("the looks store", () => {
	test("starts from its first read and keeps that start", () => {
		const at = file();
		expect(viewedFile(at, () => 100).read()).toEqual({ since: 100, threads: {} });
		expect(viewedFile(at, () => 200).read()).toEqual({ since: 100, threads: {} });
	});

	test("two sessions' looks merge, keeping each thread's latest", () => {
		const at = file();
		const one = viewedFile(at, () => 100);
		const two = viewedFile(at, () => 100);
		one.mark("th-a", 500);
		two.mark("th-b", 600);
		two.mark("th-a", 400);
		expect(one.read()).toEqual({ since: 100, threads: { "th-a": 500, "th-b": 600 } });
		expect(JSON.parse(readFileSync(at, "utf8"))).toEqual({ since: 100, threads: { "th-a": 500, "th-b": 600 } });
	});

	test("a file that does not parse starts afresh instead of failing", () => {
		const at = file();
		viewedFile(at, () => 100).read();
		writeFileSync(at, "{ not json");
		expect(viewedFile(at, () => 300).read()).toEqual({ since: 300, threads: {} });
		writeFileSync(at, JSON.stringify({ since: 1, threads: { "th-a": "yesterday" } }));
		expect(viewedFile(at, () => 400).read()).toEqual({ since: 400, threads: {} });
	});
});

describe("the settings store", () => {
	test("shows the strip until it is turned off, and later sessions read the setting", () => {
		const at = file("settings.json");
		expect(settingsFile(at).read()).toEqual({ strip: true });
		settingsFile(at).write({ strip: false });
		expect(settingsFile(at).read()).toEqual({ strip: false });
		expect(JSON.parse(readFileSync(at, "utf8"))).toEqual({ strip: false });
	});

	test("a file that does not parse reads as the defaults, and a write that fails throws", () => {
		const at = file("settings.json");
		settingsFile(at).write({ strip: false });
		writeFileSync(at, JSON.stringify({ strip: "no" }));
		expect(settingsFile(at).read()).toEqual({ strip: true });
		// A file where the directory should be cannot hold the settings.
		const blocked = path.join(at, "settings.json");
		expect(() => settingsFile(blocked).write({ strip: false })).toThrow();
	});
});
