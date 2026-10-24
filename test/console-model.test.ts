import { describe, expect, test } from "bun:test";
import {
	ago,
	argumentsDiff,
	blocks,
	clock,
	composerOf,
	conversationItems,
	exitCode,
	groups,
	modelOf,
	pickerRows,
	previewLook,
	runOf,
	shownResult,
	startArgs,
	startHint,
	stepsSummary,
	threadState,
	workingMessage,
	type Item,
	type ToolItem,
} from "../extensions/nexus/console/model.ts";
import type { RenderedEntry } from "../extensions/nexus/contract.ts";
import { reduce } from "../extensions/nexus/thread.ts";
import { Scope } from "../extensions/nexus/scope.ts";
import { asked, detail, editDetails, entries, live, memorySettings, runningCall, working } from "./console-fixture.ts";
import { idA, idB, idC, idle, row, thread } from "./fixtures.ts";

const project = { id: "nexus", repoUrl: "git@example.com:nexus", defaultNode: "firebat", defaultBranch: "main" };
const tools = (items: Item[]) => items.filter((i): i is ToolItem => i.kind === "tool");

describe("thread state", () => {
	test("the agent mid-turn hides a running pylon, never a failed one", () => {
		expect(threadState(thread(idA, { agentTurnRunning: true }), "running")).toEqual(["agent working", "work"]);
		expect(threadState(thread(idA, { agentTurnRunning: true }), "failed")).toEqual(["failed", "bad"]);
		expect(threadState(thread(idA, { status: "archived", agentTurnRunning: true }), "running")).toEqual(["archived", "muted"]);
		expect(threadState(thread(idA), "absent")).toEqual(["not on its node", "muted"]);
	});

	test("times read as the dashboard's", () => {
		expect(ago(undefined, 0)).toBe("never");
		expect(ago(asked, asked + 10_000)).toBe("just now");
		expect(ago(asked, asked + 5 * 60_000)).toBe("5 min ago");
		expect(clock(72_000)).toBe("1m 12s");
		expect(clock(3_725_000)).toBe("1h 2m");
	});
});

describe("picker rows", () => {
	const all = [
		row(idA, { project: "nexus", title: "Old", createdAt: 1 }),
		row(idB, { project: "nexus", title: "New", createdAt: 2 }),
		row(idC, { project: "nexus", title: "Gone", status: "archived" }),
		row("th-ffff00002222", { project: "nexus", title: "Removed", status: "deleted" }),
		row("th-ffff00003333", { project: "loose", title: "Elsewhere" }),
	];
	const labels = (rows: ReturnType<typeof pickerRows>) =>
		rows.map((r) => (r.kind === "thread" ? r.thread.title : r.kind === "fold" ? `${r.open ? "v" : ">"} ${r.label}` : r.kind === "project" ? `# ${r.project} ${r.count}` : "+"));

	test("groups by project, open threads newest first, closed ones folded", () => {
		const rows = pickerRows(groups(all, [project]), new Set(), "");
		expect(labels(rows)).toEqual(["+", "# nexus 2", "New", "Old", "> 1 archived, 1 deleted", "# loose 1", "Elsewhere"]);
	});

	test("an unfolded project shows its closed threads", () => {
		expect(labels(pickerRows(groups(all, [project]), new Set(["nexus"]), "")).slice(4, 7)).toEqual(["v 1 archived, 1 deleted", "Gone", "Removed"]);
	});

	test("a filter matches titles and IDs, opens folds it matches and hides empty projects", () => {
		expect(labels(pickerRows(groups(all, [project]), new Set(), "gone"))).toEqual(["# nexus 2", "v 1 archived", "Gone"]);
		expect(labels(pickerRows(groups(all, [project]), new Set(), "3333"))).toEqual(["# loose 1", "Elsewhere"]);
	});
});

describe("conversation items", () => {
	test("pairs each tool call with its result, in pi's order", () => {
		const items = conversationItems(entries, live);
		expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "assistant", "tool", "assistant", "tool", "assistant", "tool"]);
		const [read, edit, test1, again] = tools(items);
		expect(read!.result.state).toBe("done");
		expect(edit!.call.name).toBe("edit");
		expect(test1!.result.state === "done" && test1!.result.message.isError).toBe(true);
		expect(again!.result).toEqual({ state: "running", output: "> probe.test.ts\n  ✓ backs off" });
		expect(items[0]).toMatchObject({ kind: "user", text: "Fix the retry in probe.ts so it backs off.", at: asked });
	});

	test("a call with no result runs only while the live run reports it", () => {
		expect(tools(conversationItems(entries, { ...live, tools: [] })).at(-1)!.result).toEqual({ state: "none" });
		// A call whose result is in the entries is done, whatever the live run says.
		const doneLive = { ...live, tools: [{ callId: "call-read", output: "stale" }] };
		expect(tools(conversationItems(entries, doneLive))[0]!.result.state).toBe("done");
	});

	test("a running call's output can be empty, and a call reads as running only once a live event names it", () => {
		const started = { ...live, tools: [{ callId: runningCall, output: "" }] };
		expect(tools(conversationItems(entries, started)).at(-1)!.result).toEqual({ state: "running", output: "" });
		expect(tools(conversationItems(entries, undefined)).at(-1)!.result).toEqual({ state: "none" });
	});

	test("a call in an aborted or failed answer carries that failure, as pi's replay does", () => {
		const aborted: RenderedEntry = {
			entry: { id: 9, model: [{ role: "assistant", model: "demo-model", stopReason: "aborted", content: [{ type: "toolCall", id: "c9", name: "bash", arguments: {} }] }] },
			text: "",
		};
		const failed: RenderedEntry = {
			entry: { id: 10, model: [{ role: "assistant", model: "demo-model", stopReason: "error", errorMessage: "overloaded", content: [{ type: "toolCall", id: "c10", name: "bash", arguments: {} }] }] },
			text: "",
		};
		const [a, f] = tools(conversationItems([aborted, failed], undefined));
		expect(a!.result).toMatchObject({ state: "done", message: { isError: true, content: [{ text: "Operation aborted" }] } });
		expect(f!.result).toMatchObject({ state: "done", message: { isError: true, content: [{ text: "overloaded" }] } });
	});

	test("the streaming answer comes last, and queued messages stay out of the transcript", () => {
		const items = conversationItems(entries, { ...live, partial: "Half an ans" });
		expect(items.at(-1)).toMatchObject({ kind: "assistant", key: "partial", streaming: true, message: { content: [{ text: "Half an ans" }] } });
		expect(items.some((i) => i.kind === "user" && i.text.includes("docs"))).toBe(false);
	});

	test("the model is the newest answer's", () => {
		expect(modelOf(entries)).toBe("demo-model");
		expect(modelOf([])).toBeUndefined();
	});
});

describe("folds and tool results", () => {
	const call = (n: number, name = "bash", args: object = { command: `npm run step${n} --x` }): ToolItem => ({
		kind: "tool",
		key: `c${n}`,
		call: { type: "toolCall", id: `c${n}`, name, arguments: args as Record<string, unknown> },
		result: { state: "done", message: { role: "toolResult", content: [{ type: "text", text: "ok" }], isError: false } },
	});
	const toolOnly = (n: number): Item => ({ kind: "assistant", key: `a${n}`, streaming: false, message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: `a${n}`, name: "bash", arguments: {} }] } });
	const text = (n: number): Item => ({ kind: "assistant", key: `t${n}`, streaming: false, message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } });

	test("four tool calls in a row fold, across answers that only call tools", () => {
		const out = blocks([toolOnly(1), call(1), toolOnly(2), call(2), call(3), call(4), text(1), call(5)]);
		expect(out.map((b) => b.kind)).toEqual(["assistant", "assistant", "steps", "assistant", "tool"]);
		expect(out[2]!.kind === "steps" && out[2]!.tools.length).toBe(4);
	});

	test("three stay unfolded", () => {
		expect(blocks([call(1), call(2), call(3)]).map((b) => b.kind)).toEqual(["tool", "tool", "tool"]);
	});

	test("a fold names its steps and counts the failed and running ones", () => {
		const bad: ToolItem = { ...call(2), result: { state: "done", message: { role: "toolResult", isError: true, content: [{ type: "text", text: "nope\nCommand exited with code 2" }] } } };
		const run: ToolItem = { ...call(3), result: { state: "running", output: "" } };
		expect(stepsSummary([call(1, "read", { path: "src/a/total.ts" }), bad, run, call(4, "grep", { pattern: "x" })])).toEqual({
			count: 4,
			names: "read total.ts, ran npm run, searched x",
			failed: 1,
			running: 1,
			exit: "2",
		});
		expect(exitCode("Command exited with code 127")).toBe("127");
	});

	test("a pending edit shows its arguments' diff, and a finished one only what it stored", () => {
		const edit: ToolItem = { ...call(1, "edit", { path: "a.ts", edits: [{ oldText: "a\nb", newText: "c" }] }), result: { state: "none" } };
		expect(argumentsDiff(edit.call)).toBe("- a\n- b\n+ c");
		expect(shownResult(edit)).toEqual({ partial: true, message: { role: "toolResult", content: [], isError: false, details: { diff: "- a\n- b\n+ c" } } });
		const runningEdit = { ...edit, result: { state: "running" as const, output: "" } };
		expect(shownResult(runningEdit)).toMatchObject({ partial: true, message: { details: { diff: "- a\n- b\n+ c" } } });
		// The stored details, exactly as a real pylon keeps them.
		const stored = tools(conversationItems(entries, live)).find((t) => t.call.name === "edit")!;
		expect(shownResult(stored)).toEqual({ partial: false, message: expect.objectContaining({ details: editDetails }) });
		// A finished edit without a diff, such as a failed one, draws its text and no made-up diff.
		const failedEdit: ToolItem = { ...edit, result: { state: "done", message: { role: "toolResult", isError: true, content: [{ type: "text", text: "Could not find the text" }] } } };
		expect(shownResult(failedEdit)!.message.details).toBeUndefined();
		const plainEdit: ToolItem = { ...edit, result: { state: "done", message: { role: "toolResult", isError: false, content: [{ type: "text", text: "Edited a.ts" }] } } };
		expect(shownResult(plainEdit)!.message.details).toBeUndefined();
		// Other calls have nothing to draw until they run.
		expect(shownResult({ ...call(2), result: { state: "none" } })).toBeUndefined();
	});
});

describe("run and composer", () => {
	test("a working run is timed from the message it answers and counts this turn's tools", () => {
		const run = runOf(working, conversationItems(entries, live));
		expect(run).toEqual({ kind: "working", since: asked, tools: 4 });
		expect(workingMessage(run as Extract<typeof run, { kind: "working" }>, asked + 72_000, false)).toBe("Working · 1m 12s · 4 tools this turn · new messages queue");
		expect(workingMessage({ kind: "working", tools: 1 }, 0, true)).toBe("Working · 1 tool this turn");
	});

	test("a parked run is stuck, not working", () => {
		expect(runOf({ ...working, run: "parked", parkedTasks: 2 }, [])).toEqual({ kind: "parked", tasks: 2 });
		expect(runOf(idle, [])).toEqual({ kind: "idle" });
	});

	test("says why a thread takes no messages", () => {
		expect(composerOf({ ...idle, status: "deleted" }, detail)).toMatchObject({ kind: "closed" });
		expect(composerOf(undefined, { ...detail, thread: { ...detail.thread, conversationId: null } })).toMatchObject({ kind: "closed", reason: "This thread has no agent conversation." });
		expect(composerOf({ ...idle, failed: "setup failed" }, { ...detail, pylon: { ...detail.pylon, retryRefused: "The disk is gone" } })).toEqual({
			kind: "failed",
			failed: "setup failed",
			refused: "The disk is gone",
		});
		expect(composerOf({ ...idle, status: "archived" }, detail)).toEqual({ kind: "archived" });
		expect(composerOf({ ...idle, pylon: "paused" }, detail)).toEqual({ kind: "open", paused: true });
	});

	test("the watch's state is newer than the detail", () => {
		expect(composerOf(idle, { ...detail, pylon: { ...detail.pylon, failed: "old failure" } })).toEqual({ kind: "open", paused: false });
		expect(composerOf(undefined, { ...detail, pylon: { ...detail.pylon, failed: "failure" } })).toMatchObject({ kind: "failed" });
	});

	test("a live event survives the state events after it", () => {
		const view = reduce(reduce({ entries: [] }, { type: "live", thread: idA, ...live }), { type: "state", thread: idA, ...working });
		expect(view.live).toEqual(live);
		expect(view.state).toEqual(working);
	});
});

describe("previews and starting", () => {
	test("a paused pylon's preview keeps its link and an archived thread's does not", () => {
		expect(previewLook(detail, true)).toEqual({ linked: true, label: null, tone: "ok", hint: null });
		expect(previewLook(detail, false)).toMatchObject({ linked: false, label: "starting" });
		expect(previewLook({ ...detail, pylon: { ...detail.pylon, actualState: "paused" } }, true)).toMatchObject({ linked: true, hint: "Opening it wakes the pylon." });
		expect(previewLook({ ...detail, thread: { ...detail.thread, status: "archived" } }, true)).toMatchObject({ linked: false });
	});

	test("empty optional fields are left to the project's defaults", () => {
		expect(startArgs({ title: " Fix it ", project: "nexus", node: "", branch: "", message: "" })).toEqual({ project: "nexus", title: "Fix it" });
		expect(startArgs({ title: "", project: "nexus", node: "nuc", branch: "dev", message: "go" })).toEqual({ project: "nexus", message: "go", node: "nuc", branch: "dev" });
		expect(startHint(project, { title: "", project: "nexus", node: "", branch: "", message: "" })).toBe("Boots a pylon on firebat and checks out main.");
		expect(startHint(project, { title: "", project: "nexus", node: "nuc", branch: "dev", message: "" })).toBe("Boots a pylon on nuc and checks out dev.");
	});
});

describe("the project scope", () => {
	test("a projects list read for an older scope leaves the scope chosen since alone", () => {
		const settings = memorySettings({ project: "gone" });
		const said: string[] = [];
		const scope = new Scope(settings, (message) => said.push(message), () => {});
		const asked = scope.project;
		scope.set("fresh");
		// The list was read before fresh existed, so it cannot say fresh is gone.
		scope.check([project], asked);
		expect(scope.project).toBe("fresh");
		scope.check([project], scope.project);
		expect(scope.project).toBeNull();
		expect(said).toEqual(["The project fresh no longer exists, so Nexus shows every project again."]);
		expect(settings.writes).toEqual([{ project: "fresh" }, { project: null }]);
	});
});
