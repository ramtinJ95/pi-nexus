import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { forgetLooks, settingsFile } from "../extensions/nexus/store.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A pi session changing its settings by `change` in another process, holding the lock for `holdMs` between its read and write. */
const racer = (at: string, change: object, holdMs: number) =>
	Bun.spawn(["bun", path.join(import.meta.dir, "store-racer.ts"), at, JSON.stringify(change), String(holdMs)], { stdout: "pipe", stderr: "pipe" });

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

function file(name = "settings.json") {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-nexus-store-"));
	dirs.push(dir);
	return path.join(dir, "pi-nexus", name);
}

describe("the looks store", () => {
	test("is removed, since the control plane keeps when each reply was seen", () => {
		const at = file("viewed.json");
		mkdirSync(path.dirname(at), { recursive: true });
		writeFileSync(at, JSON.stringify({ since: 1, threads: {} }));
		forgetLooks(at);
		expect(existsSync(at)).toBe(false);
		forgetLooks(at);
		expect(existsSync(at)).toBe(false);
	});
});

describe("the settings store", () => {
	test("keeps the uncommitted base between sessions and alongside other choices", () => {
		const at = file();
		expect(settingsFile(at).read().uncommitted ?? false).toBe(false);
		settingsFile(at).update({ uncommitted: true });
		settingsFile(at).update({ project: "nexus", strip: false });
		expect(settingsFile(at).read()).toEqual({ strip: false, project: "nexus", uncommitted: true });
	});
	test("shows the strip and every project until changed, and later sessions read the settings", () => {
		const at = file();
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
		const at = file();
		settingsFile(at).update({ strip: true });
		writeFileSync(at, JSON.stringify({ strip: false }));
		expect(settingsFile(at).read()).toEqual({ strip: false, project: null });
	});

	test("a file that does not parse reads as the defaults, and a write that fails throws", () => {
		const at = file();
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
		const at = file();
		settingsFile(at).update({ strip: true });
		const first = racer(at, { project: "spoon" }, 300);
		await holding(first);
		// The first is between its read and its write, so without the lock one of the two changes is lost.
		const second = racer(at, { strip: false }, 0);
		expect(await Promise.all([first.exited, second.exited])).toEqual([0, 0]);
		expect(settingsFile(at).read()).toEqual({ strip: false, project: "spoon" });
	});

	test("a live session's lock is never taken over, however old", () => {
		const at = file();
		settingsFile(at).update({ strip: true });
		const lock = `${at}.lock`;
		writeFileSync(lock, `${process.pid} someone-else`);
		const minuteAgo = new Date(Date.now() - 60_000);
		utimesSync(lock, minuteAgo, minuteAgo);
		expect(() => settingsFile(at).update({ strip: false })).toThrow("is held by another pi session");
		expect(readFileSync(lock, "utf8")).toBe(`${process.pid} someone-else`);
		expect(settingsFile(at).read().strip).toBe(true);
	});

	test("a dead session's lock is taken over at once", async () => {
		const at = file();
		settingsFile(at).update({ strip: true });
		const dead = Bun.spawn(["true"]);
		await dead.exited;
		writeFileSync(`${at}.lock`, `${dead.pid} gone`);
		settingsFile(at).update({ strip: false });
		expect(settingsFile(at).read().strip).toBe(false);
		expect(existsSync(`${at}.lock`)).toBe(false);
	});

	test("a lock whose owner cannot be read is taken over only once stale", () => {
		const at = file();
		settingsFile(at).update({ strip: true });
		const lock = `${at}.lock`;
		writeFileSync(lock, "");
		expect(() => settingsFile(at).update({ strip: false })).toThrow("is held by another pi session");
		const minuteAgo = new Date(Date.now() - 60_000);
		utimesSync(lock, minuteAgo, minuteAgo);
		settingsFile(at).update({ strip: false });
		expect(settingsFile(at).read().strip).toBe(false);
	});

	test("a session releases only its own lock", async () => {
		const at = file();
		settingsFile(at).update({ strip: true });
		const holder = racer(at, { strip: false }, 300);
		await holding(holder);
		// Another session's lock in its place, as after a takeover, outlives the first session's release.
		writeFileSync(`${at}.lock`, "4242 another");
		expect(await holder.exited).toBe(0);
		expect(readFileSync(`${at}.lock`, "utf8")).toBe("4242 another");
	});
});
