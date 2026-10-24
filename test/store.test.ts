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

	test("two sessions that mark at the same moment both keep their look", async () => {
		const at = file();
		viewedFile(at, () => 1).read();
		const racer = path.join(import.meta.dir, "store-racer.ts");
		// Each holds between its read and its write, so without a lock both read the empty store and the later
		// rename drops the other's look.
		const race = (thread: string, when: number) => Bun.spawn(["bun", racer, at, thread, String(when), "300"], { stderr: "pipe" });
		const runs = [race("th-a", 500), race("th-b", 600)];
		const codes = await Promise.all(runs.map((r) => r.exited));
		expect(codes).toEqual([0, 0]);
		expect(viewedFile(at).read().threads).toEqual({ "th-a": 500, "th-b": 600 });
	});

	test("a prune drops the looks at threads the list no longer has, but not a look newer than the list", () => {
		const at = file();
		const store = viewedFile(at, () => 100);
		store.mark("th-kept", 200);
		store.mark("th-deleted", 300);
		store.mark("th-new", 900);
		store.prune(new Set(["th-kept"]), 500);
		expect(store.read()).toEqual({ since: 100, threads: { "th-kept": 200, "th-new": 900 } });
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
