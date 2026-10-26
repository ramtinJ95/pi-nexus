import { afterEach, describe, expect, test } from "bun:test";
import { createNexus, listThreads, markSeen, readChanges, readConversation, readDiff, sendText, showThread } from "../extensions/nexus/cli.ts";
import { detail } from "./console-fixture.ts";
import { fakeNexus, idA, row, type Scenario } from "./fixtures.ts";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function nexus(scenario: Scenario) {
	const fake = fakeNexus(scenario);
	cleanups.push(fake.cleanup);
	return { nexus: createNexus(fake.bin), calls: fake.calls, bin: fake.bin };
}

const changes = { base: { kind: "turn", commit: "5a1e" }, files: [], truncated: false };

describe("the CLI's shared seen state", () => {
	test("rows and details carry when the reply came, when it was seen and what the thread wants", async () => {
		const shared = { seenAt: 1_000, lastReplyAt: 2_000, attention: "reply" };
		const n = nexus({ responses: { threads: [row(idA, shared)], show: { ...detail, ...shared, claudeWorker: { model: "claude-opus-5-5", state: "started" } } } });
		expect(await listThreads(n.nexus)).toEqual([expect.objectContaining(shared)]);
		expect(await showThread(n.nexus, idA)).toMatchObject({ ...shared, claudeWorker: { model: "claude-opus-5-5", state: "started" } });
	});

	test("an attention value added later still lists the thread", async () => {
		const n = nexus({ responses: { threads: [row(idA, { attention: "stalled" })] } });
		expect((await listThreads(n.nexus))[0]!.attention).toBe("stalled");
	});

	test("a reply without the fields from a CLI older than 0.10.0 names the version it needs", async () => {
		const { seenAt: _seenAt, ...old } = row(idA);
		const { attention: _attention, ...oldDetail } = detail;
		const n = nexus({ version: "0.9.0", responses: { threads: [old], show: oldDetail } });
		const needs = `${n.bin} is 0.9.0: reading when replies were seen needs Nexus CLI 0.10.0 or later (nexus --version)`;
		await expect(listThreads(n.nexus)).rejects.toThrow(needs);
		await expect(showThread(n.nexus, idA)).rejects.toThrow(needs);
	});

	test("a newer CLI's reply without the fields fails as a contract error naming the field", async () => {
		const { seenAt: _seenAt, ...old } = row(idA);
		await expect(listThreads(nexus({ responses: { threads: [old] } }).nexus)).rejects.toThrow(`nexus threads' row for ${idA} has no seenAt, which pi-nexus needs`);
	});

	test("seen runs nexus seen after --", async () => {
		const n = nexus({ responses: { seen: null } });
		await markSeen(n.nexus, idA);
		expect(n.calls()).toEqual([["--version"], ["seen", "--json", "--", idA]]);
	});

	test("a CLI older than 0.10.0 is refused before it marks anything", async () => {
		const n = nexus({ version: "0.9.0" });
		await expect(markSeen(n.nexus, idA)).rejects.toThrow(`${n.bin} is 0.9.0: marking a reply seen needs Nexus CLI 0.10.0 or later (nexus --version)`);
		expect(n.calls()).toEqual([["--version"]]);
	});
});

describe("the CLI's latest-turn base", () => {
	test("turn passes --turn to changes and diff", async () => {
		const n = nexus({ responses: { changes, diff: { base: changes.base, diff: "", truncated: false } } });
		expect((await readChanges(n.nexus, idA, "turn")).base.kind).toBe("turn");
		await readDiff(n.nexus, idA, ["src/a.ts"], "turn");
		expect(n.calls().filter((c) => c[0] !== "--version")).toEqual([["changes", "--json", "--turn", "--", idA], ["diff", "--json", "--turn", "--", idA, "src/a.ts"]]);
	});

	test("a CLI older than 0.11.0 is refused before it reads", async () => {
		const n = nexus({ version: "0.10.0", responses: { changes } });
		await expect(readChanges(n.nexus, idA, "turn")).rejects.toThrow(`${n.bin} is 0.10.0: reading the latest turn's changes needs Nexus CLI 0.11.0 or later (nexus --version)`);
		expect(n.calls()).toEqual([["--version"]]);
	});
});

describe("the CLI's Claude worker transcript", () => {
	const conversation = {
		kind: "claude",
		session: "5e55",
		entries: [
			{ kind: "prompt", at: 1, text: "Fix the probe", from: "person" },
			{ kind: "hologram", at: 2, text: "from a newer Claude Code" },
			{ kind: "reply", at: 3, text: "Done.", tokens: 12 },
		],
		dropped: 0,
		readAt: 4,
		working: false,
	};

	test("conversation reads the transcript and drops the entry kinds it does not know", async () => {
		const n = nexus({ responses: { conversation } });
		const read = await readConversation(n.nexus, idA);
		expect(read.entries.map((e) => e.kind)).toEqual(["prompt", "reply"]);
		expect(read).toMatchObject({ dropped: 0, readAt: 4, working: false });
		expect(n.calls().at(-1)).toEqual(["conversation", "--json", "--", idA]);
	});

	test("a known entry that breaks its shape fails as a contract error", async () => {
		const n = nexus({ responses: { conversation: { ...conversation, entries: [{ kind: "reply", at: 3 }] } } });
		await expect(readConversation(n.nexus, idA)).rejects.toThrow(`nexus conversation ${idA}'s entry 0 has no text, which pi-nexus needs`);
	});

	test("a CLI older than 0.17.0 is refused before it reads", async () => {
		const n = nexus({ version: "0.16.1", responses: { conversation } });
		await expect(readConversation(n.nexus, idA)).rejects.toThrow(`${n.bin} is 0.16.1: reading a Claude worker's transcript needs Nexus CLI 0.17.0 or later (nexus --version)`);
		expect(n.calls()).toEqual([["--version"]]);
	});

	test("send returns the submission, or what Claude did with the message", async () => {
		expect(await sendText(nexus({ responses: { send: { submission: 7 } } }).nexus, idA, "hi", false)).toEqual({ submission: 7 });
		const claude = { claude: { session: "5e55", outcome: "queued", resumed: true } };
		expect(await sendText(nexus({ responses: { send: claude } }).nexus, idA, "hi", false)).toEqual(claude);
		await expect(sendText(nexus({ responses: { send: null } }).nexus, idA, "hi", false)).rejects.toThrow("nexus send breaks the contract");
	});
});
