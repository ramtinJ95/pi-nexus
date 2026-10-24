import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { settingsFile, viewedFile } from "../extensions/nexus/store.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A pi session marking `thread` in another process, holding the lock for `holdMs` between its read and write. */
const racer = (at: string, thread: string, when: number, holdMs: number) =>
	Bun.spawn(["bun", path.join(import.meta.dir, "store-racer.ts"), at, thread, String(when), String(holdMs)], { stdout: "pipe", stderr: "pipe" });

/** A pi session changing its settings by `change` in another process, holding the lock for `holdMs` as `racer` does. */
const settingsRacer = (at: string, change: object, holdMs: number) =>
	Bun.spawn(["bun", path.join(import.meta.dir, "store-racer.ts"), "--settings", at, JSON.stringify(change), String(holdMs)], { stdout: "pipe", stderr: "pipe" });

/** Waits until `run` says it holds the lock. */
async function holding(run: ReturnType<typeof racer>): Promise<void> {
	const reader = run.stdout.getReader();
	let out = "";
	while (!out.includes("held")) {
		const { value, done } = await reader.read();
		if (done) throw new Error(`the racer ended before it held the lock: ${await new Response(run.stderr).text()}`);
		out += new TextDecoder().decode(value);
	}
	reader.releaseLock();
}

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

	test("a session that marks while another holds the lock waits its turn, so both keep their look", async () => {
		const at = file();
		viewedFile(at, () => 1).read();
		const first = racer(at, "th-a", 500, 300);
		await holding(first);
		// The first is between its read and its write, so without a lock the second's write is lost.
		const second = racer(at, "th-b", 600, 0);
		expect(await Promise.all([first.exited, second.exited])).toEqual([0, 0]);
		expect(viewedFile(at).read().threads).toEqual({ "th-a": 500, "th-b": 600 });
	});

	test("a live session's lock is never taken over, however old", () => {
		const at = file();
		viewedFile(at, () => 1).read();
		const lock = `${at}.lock`;
		writeFileSync(lock, `${process.pid} someone-else`);
		const minuteAgo = new Date(Date.now() - 60_000);
		utimesSync(lock, minuteAgo, minuteAgo);
		expect(() => viewedFile(at).mark("th-a", 500)).toThrow("is held by another pi session");
		expect(readFileSync(lock, "utf8")).toBe(`${process.pid} someone-else`);
		expect(viewedFile(at).read().threads).toEqual({});
	});

	test("a dead session's lock is taken over at once", async () => {
		const at = file();
		viewedFile(at, () => 1).read();
		const dead = Bun.spawn(["true"]);
		await dead.exited;
		writeFileSync(`${at}.lock`, `${dead.pid} gone`);
		viewedFile(at).mark("th-a", 500);
		expect(viewedFile(at).read().threads).toEqual({ "th-a": 500 });
		expect(existsSync(`${at}.lock`)).toBe(false);
	});

	test("a lock whose owner cannot be read is taken over only once stale", () => {
		const at = file();
		viewedFile(at, () => 1).read();
		const lock = `${at}.lock`;
		writeFileSync(lock, "");
		expect(() => viewedFile(at).mark("th-a", 500)).toThrow("is held by another pi session");
		const minuteAgo = new Date(Date.now() - 60_000);
		utimesSync(lock, minuteAgo, minuteAgo);
		viewedFile(at).mark("th-a", 500);
		expect(viewedFile(at).read().threads).toEqual({ "th-a": 500 });
	});

	test("a session releases only its own lock", async () => {
		const at = file();
		viewedFile(at, () => 1).read();
		const holder = racer(at, "th-a", 500, 300);
		await holding(holder);
		// Another session's lock in its place, as after a takeover, outlives the first session's release.
		writeFileSync(`${at}.lock`, "4242 another");
		expect(await holder.exited).toBe(0);
		expect(readFileSync(`${at}.lock`, "utf8")).toBe("4242 another");
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
	test("shows the strip and every project until changed, and later sessions read the settings", () => {
		const at = file("settings.json");
		expect(settingsFile(at).read()).toEqual({ strip: true, project: null });
		settingsFile(at).update({ strip: false });
		expect(settingsFile(at).read()).toEqual({ strip: false, project: null });
		settingsFile(at).update({ project: "spoon" });
		expect(settingsFile(at).read()).toEqual({ strip: false, project: "spoon" });
		expect(JSON.parse(readFileSync(at, "utf8"))).toEqual({ strip: false, project: "spoon" });
		settingsFile(at).update({ project: null });
		expect(JSON.parse(readFileSync(at, "utf8"))).toEqual({ strip: false, project: null });
	});

	test("a file from before projects reads as every project, and keeps its strip", () => {
		const at = file("settings.json");
		settingsFile(at).update({ strip: true });
		writeFileSync(at, JSON.stringify({ strip: false }));
		expect(settingsFile(at).read()).toEqual({ strip: false, project: null });
	});

	test("a file that does not parse reads as the defaults, and a write that fails throws", () => {
		const at = file("settings.json");
		settingsFile(at).update({ strip: false });
		writeFileSync(at, JSON.stringify({ strip: "no" }));
		expect(settingsFile(at).read()).toEqual({ strip: true, project: null });
		writeFileSync(at, JSON.stringify({ strip: false, project: 7 }));
		expect(settingsFile(at).read()).toEqual({ strip: true, project: null });
		// A file where the directory should be cannot hold the settings.
		const blocked = path.join(at, "settings.json");
		expect(() => settingsFile(blocked).update({ strip: false })).toThrow();
	});

	test("a session that changes a setting while another holds the lock waits its turn, so both changes stay", async () => {
		const at = file("settings.json");
		settingsFile(at).update({ strip: true });
		const first = settingsRacer(at, { project: "spoon" }, 300);
		await holding(first);
		// The first is between its read and its write, so without the lock one of the two changes is lost.
		const second = settingsRacer(at, { strip: false }, 0);
		expect(await Promise.all([first.exited, second.exited])).toEqual([0, 0]);
		expect(settingsFile(at).read()).toEqual({ strip: false, project: "spoon" });
	});
});
