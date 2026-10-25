import { afterEach, describe, expect, test } from "bun:test";
import { createNexus, readChanges, readDiff } from "../extensions/nexus/cli.ts";
import { Checkout, changesLines, maxDiffRows, parseDiff, statusLetter, treeRows, type CheckoutFacts } from "../extensions/nexus/console/changes.ts";
import type { ChangedFile, Changes, Diff } from "../extensions/nexus/contract.ts";
import { fakeNexus, idA } from "./fixtures.ts";
import { piTheme, plain } from "./console-fixture.ts";

const file = (path: string, extra: Partial<ChangedFile> = {}): ChangedFile => ({ path, oldPath: null, status: "modified", additions: 12, deletions: 3, ...extra });
const base = { kind: "start", commit: "9abe10e123456" } as const;
const changed = (files = [file("src/checkout/main.ts")]): Changes => ({ base, files, truncated: false });
const patch = "diff --git a/old.ts b/new.ts\nsimilarity index 80%\nrename from old.ts\nrename to new.ts\nold mode 100644\nnew mode 100755\n--- a/old.ts\n+++ b/new.ts\n@@ -2,2 +3,3 @@ function check()\n context\n-removed\n+added\n+extra\n\\ No newline at end of file\n@@ -30 +42 @@\n-last\n+last\n";
const diff: Diff = { base, diff: patch, truncated: false };
const running: CheckoutFacts = { status: "active", pylon: "running", working: false, agentAt: 1 };
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function reader(facts = running) {
	const reads: { head: boolean; signal: AbortSignal; resolve(value: Changes): void; reject(err: Error): void }[] = [];
	const diffs: { paths: readonly string[]; head: boolean; signal: AbortSignal; resolve(value: Diff): void }[] = [];
	const persisted: boolean[] = [];
	const checkout = new Checkout({
		changes: (head, signal) => new Promise((resolve, reject) => reads.push({ head, signal, resolve, reject })),
		diff: (paths, head, signal) => new Promise((resolve) => diffs.push({ paths, head, signal, resolve })),
		persist: (head) => { persisted.push(head); },
	}, false, () => {});
	checkout.update(facts);
	cleanup.push(() => checkout.dispose());
	return { checkout, reads, diffs, persisted, text: () => plain(changesLines(piTheme(), checkout, 0, 100).lines) };
}

describe("Changes tree and diff", () => {
	test("merges single-folder chains, sorts folders before files, and preserves fold keys", () => {
		const files = [file("z.ts"), file("src/checkout/z.ts"), file("src/checkout/a.ts"), file("assets/logo.png"), file("a.ts")];
		const rows = treeRows(files, new Set());
		expect(rows.map((r) => [r.name, r.depth])).toEqual([["assets", 0], ["logo.png", 1], ["src/checkout", 0], ["a.ts", 1], ["z.ts", 1], ["a.ts", 0], ["z.ts", 0]]);
		expect(treeRows(files, new Set(["src/checkout"])).map((r) => r.path)).not.toContain("src/checkout/a.ts");
	});
	test("renders every badge, binary counts, rename source and truncation", () => {
		const r = reader();
		r.checkout.changes = { ...changed(Object.keys(statusLetter).map((status) => file(`${status}.ts`, { status: status as ChangedFile["status"], oldPath: status === "renamed" ? "old.ts" : null }))), truncated: true };
		r.checkout.changes.files.push(file("image.png", { additions: null, deletions: null }));
		const text = r.text();
		for (const [status, badge] of Object.entries(statusLetter)) expect(text).toContain(`${badge} ${status}.ts`);
		expect(text).toContain("binary");
		expect(text).toContain("← old.ts");
		expect(text).toContain("7 files · +72 −18");
		expect(text).toContain("since the pylon booted, 9abe10e");
		expect(text).toContain("Showing the first 7 files.");
	});
	test("tree and diff status letters use pi's diff, accent and dim theme keys", () => {
		const t = piTheme(), r = reader();
		for (const [status, color] of [["added", "toolDiffAdded"], ["deleted", "toolDiffRemoved"], ["modified", "accent"], ["renamed", "accent"], ["copied", "dim"], ["typechange", "dim"]] as const) {
			const f = file("status.ts", { status });
			r.checkout.file = undefined;
			r.checkout.changes = changed([f]);
			expect(changesLines(t, r.checkout, 0, 100).lines.join("\n")).toContain(`${t.fg(color, statusLetter[status])} status.ts`);
			r.checkout.file = f;
			expect(changesLines(t, r.checkout, 0, 100).lines[0]).toContain(`${t.fg(color, statusLetter[status])} status.ts`);
		}
	});
	test("empty repositories and empty changes use the chosen base's wording", () => {
		const r = reader();
		r.checkout.changes = { ...changed([]), base: { kind: "start", commit: null } };
		expect(r.text()).toContain("an empty repository");
		expect(r.text()).toContain("Nothing has changed since the pylon booted.");
		r.checkout.uncommitted = true;
		r.checkout.changes.base.kind = "head";
		expect(r.text()).toContain("no commit yet");
		expect(r.text()).toContain("No uncommitted changes.");
	});
	test("parses hunks, only new line numbers, rename/mode metadata and no-newline markers", () => {
		const parsed = parseDiff(patch);
		expect(parsed.meta).toEqual(["similarity index 80%", "rename from old.ts", "rename to new.ts", "old mode 100644", "new mode 100755"]);
		expect(parsed.rows.map((r) => [r.kind, r.line, r.text])).toEqual([
			["hunk", null, "function check()"], ["context", 3, "context"], ["remove", null, "removed"], ["add", 4, "added"], ["add", 5, "extra"],
			["hunk", null, ""], ["remove", null, "last"], ["add", 42, "last"],
		]);
		expect(parsed.truncated).toBe(false);
	});
	test("caps rows at 20,000 and reports CLI truncation independently", () => {
		const long = "@@ -0,0 +1,20000 @@\n" + "+line\n".repeat(maxDiffRows);
		expect(parseDiff(long).rows).toHaveLength(maxDiffRows);
		expect(parseDiff(long).truncated).toBe(true);
		const r = reader();
		r.checkout.file = file("a.ts"); r.checkout.diff = { ...diff, truncated: true };
		expect(r.text()).toContain("The diff is cut short here, because the whole of it is too long to show.");
	});
	test("binary, metadata-only, vanished changes and long lines", () => {
		const r = reader(); r.checkout.file = file("a.ts");
		for (const [patch, expected] of [
			["Binary files a/a.png and b/a.png differ", "The file is binary, so there is no diff to show."],
			["rename from a.ts\nrename to b.ts", "No lines changed."],
			["", "The file has no changes now."],
		]) { r.checkout.diff = { ...diff, diff: patch! }; expect(r.text()).toContain(expected!); }
		r.checkout.diff = { ...diff, diff: "@@ -0,0 +1 @@\n+" + "x".repeat(300) };
		expect(changesLines(piTheme(), r.checkout, 0, 40).lines).toHaveLength(4);
	});
});

describe("checkout read policy", () => {
	test("nothing reads until first shown; no timer or unchanged-state refresh; turn end and activity change read", async () => {
		const r = reader();
		r.checkout.update({ ...running, agentAt: 2 }); expect(r.reads).toHaveLength(0);
		r.checkout.show(); expect(r.reads).toHaveLength(1);
		r.reads[0]!.resolve(changed()); await tick();
		r.checkout.show(); r.checkout.update({ ...running, agentAt: 2 }); await tick(); expect(r.reads).toHaveLength(1);
		r.checkout.update({ ...running, working: true, agentAt: 2 }); expect(r.reads).toHaveLength(1);
		r.checkout.update({ ...running, agentAt: 3 }); expect(r.reads).toHaveLength(2);
		r.reads[1]!.resolve(changed()); await tick();
		r.checkout.update({ ...running, agentAt: 4 }); expect(r.reads).toHaveLength(3);
	});
	test("a visit's wake reads the first changes only once the observed pylon runs", async () => {
		const r = reader({ ...running, pylon: "paused" });
		r.checkout.show();
		r.checkout.update({ ...running, pylon: "spawning" });
		expect(r.reads).toHaveLength(0);
		expect(r.text()).toContain("The pylon is spawning. Reading its changes wakes it.");
		r.checkout.update(running);
		expect(r.reads).toHaveLength(1);
		r.reads[0]!.resolve(changed()); await tick();
		r.checkout.update(running);
		expect(r.reads).toHaveLength(1);
		const unseen = reader({ ...running, pylon: "paused" });
		unseen.checkout.update(running);
		expect(unseen.reads).toHaveLength(0);
	});
	test("paused pylons do not read or wake implicitly, including turn end and toggle", async () => {
		const paused = { ...running, pylon: "paused" };
		const r = reader(paused); r.checkout.show(); r.checkout.toggle();
		r.checkout.update({ ...paused, agentAt: 2 }); expect(r.reads).toHaveLength(0);
		expect(r.text()).toContain("The pylon is paused. Reading its changes wakes it.");
		r.checkout.refresh(true); expect(r.reads).toHaveLength(1);
		expect(r.text()).toContain("Waking the pylon. Its changes show once it runs.");
		r.checkout.update(running); expect(r.reads).toHaveLength(1);
		r.reads[0]!.resolve({ ...changed(), base: { kind: "head", commit: null } }); await tick();
		expect(r.checkout.wanted).toBe(false); expect(r.reads).toHaveLength(1);
	});
	test("archived and deleted refuse even an explicit wake; later closure prevents queued reads", async () => {
		for (const status of ["archived", "deleted"]) {
			const r = reader({ ...running, status }); r.checkout.show(); r.checkout.refresh(true); r.checkout.toggle();
			expect(r.reads).toHaveLength(0); expect(r.text().replace(/\s+/g, " ")).toContain(status === "deleted" ? "checkout is gone" : "Unarchive the thread to read them");
		}
		const r = reader(); r.checkout.show(); r.checkout.toggle(); r.checkout.update({ ...running, status: "archived" });
		r.reads[0]!.resolve(changed()); await tick(); expect(r.reads).toHaveLength(1);
	});
	test("toggle during a read queues the new base, drops old replies/errors, and persists the choice", async () => {
		const r = reader(); r.checkout.show(); r.checkout.toggle();
		expect(r.reads).toHaveLength(1); expect(r.persisted).toEqual([true]);
		r.reads[0]!.resolve(changed()); await tick();
		expect(r.checkout.changes).toBeUndefined(); expect(r.reads.map((x) => x.head)).toEqual([false, true]);
		r.checkout.toggle(); r.reads[1]!.reject(new Error("stale refusal")); await tick();
		expect(r.checkout.error).toBeUndefined(); expect(r.reads.map((x) => x.head)).toEqual([false, true, false]);
		r.reads[2]!.resolve(changed()); await tick(); expect(r.checkout.changes).toEqual(changed());
	});
	test("re-read keeps the last result, coalesces requests, shows no-base refusal and c hint", async () => {
		const r = reader(); r.checkout.show(); r.reads[0]!.resolve(changed()); await tick();
		r.checkout.refresh(); expect(r.text()).toContain("Reading the changes…"); expect(r.text()).toContain("main.ts");
		r.checkout.refresh(); r.checkout.refresh(); expect(r.reads).toHaveLength(2);
		r.reads[1]!.resolve(changed()); await tick(); expect(r.reads).toHaveLength(3);
		r.reads[2]!.reject(new Error("No recorded base; ask for changes since HEAD instead")); await tick();
		expect(r.text()).toContain("No recorded base"); expect(r.text()).toContain("c shows the uncommitted changes");
	});
	test("renamed diff gets both paths, paused diff offers wake, and returning drops an in-flight diff", async () => {
		const r = reader(); r.checkout.show(); r.reads[0]!.resolve(changed()); await tick();
		r.checkout.update({ ...running, pylon: "paused" });
		r.checkout.open(file("new.ts", { oldPath: "old.ts", status: "renamed" })); expect(r.diffs).toHaveLength(0);
		r.checkout.refresh(true); expect(r.reads).toHaveLength(2);
		r.reads[1]!.resolve(changed()); await tick();
		// The CLI can answer before the watch reports running. The requested diff must still complete.
		r.checkout.update(running); await tick(); expect(r.diffs).toHaveLength(1);
		expect(r.diffs[0]!.paths).toEqual(["new.ts", "old.ts"]);
		r.checkout.back(); r.diffs[0]!.resolve(diff); await tick(); expect(r.checkout.diff).toBeUndefined();
	});
	test("only one child at a time; a diff's old base is discarded; close aborts the active child", async () => {
		const r = reader(); r.checkout.show(); r.reads[0]!.resolve(changed()); await tick();
		r.checkout.open(file("a.ts")); r.checkout.toggle(); expect(r.reads).toHaveLength(1);
		r.diffs[0]!.resolve(diff); await tick(); expect(r.checkout.diff).toBeUndefined(); expect(r.reads).toHaveLength(2);
		r.checkout.dispose(); expect(r.reads[1]!.signal.aborted).toBe(true);
		r.reads[1]!.resolve(changed()); await tick(); expect(r.checkout.changes).toBeUndefined(); expect(r.diffs).toHaveLength(1);
	});
});

describe("checkout CLI contract", () => {
	test("validates replies and protects both rename paths from flags", async () => {
		const fake = fakeNexus({ responses: { changes: changed(), diff } }); cleanup.push(fake.cleanup);
		const nexus = createNexus(fake.bin);
		expect(await readChanges(nexus, idA, true)).toEqual(changed());
		expect(await readDiff(nexus, idA, ["--new.ts", "old name.ts"], false)).toEqual(diff);
		expect(fake.calls()).toEqual([["changes", "--json", "--uncommitted", "--", idA], ["diff", "--json", "--", idA, "--new.ts", "old name.ts"]]);
	});
	test("old CLI says to update, missing fields fail, and no-base refusal retains the CLI message", async () => {
		for (const command of ["changes", "diff"] as const) {
			const fake = fakeNexus({ fail: { [command]: { exit: 64, kind: "invalid", error: `unknown command ${command}` } } }); cleanup.push(fake.cleanup);
			const nexus = createNexus(fake.bin);
			await expect(command === "changes" ? readChanges(nexus, idA, false) : readDiff(nexus, idA, [], false)).rejects.toThrow("needs Nexus CLI 0.6.0 or later (nexus --version). Update the nexus CLI.");
		}
		const missing = fakeNexus({ responses: { changes: { ...changed(), base: { kind: "start" } } } }); cleanup.push(missing.cleanup);
		await expect(readChanges(createNexus(missing.bin), idA, false)).rejects.toThrow("commit");
		const noBase = fakeNexus({ fail: { changes: { exit: 1, kind: "failed", error: "Ask for the changes since HEAD instead" } } }); cleanup.push(noBase.cleanup);
		await expect(readChanges(createNexus(noBase.bin), idA, false)).rejects.toThrow("Ask for the changes since HEAD instead");
	});
	test("aborting the checkout stops a real CLI child", async () => {
		const fake = fakeNexus({ responses: { changes: changed() }, delayMs: { changes: 10_000 } }); cleanup.push(fake.cleanup);
		const stop = new AbortController();
		const result = readChanges(createNexus(fake.bin), idA, false, stop.signal);
		stop.abort();
		await expect(result).rejects.toThrow("aborted");
	});
});
