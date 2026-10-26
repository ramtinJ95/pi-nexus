/**
 * What pi-nexus makes of a Nexus thread, from the shapes in contract.ts. The settle rule, the trims and the thread
 * matching match the Claude Code Nexus mod's hooks/model.ts, so both agents behave the same.
 */
import type { ClaudeConversation, ClaudeEntry, LiveRun, Part, RenderedEntry, Thread, ThreadDetail, ThreadRow, ThreadState, WatchEvent } from "./contract.ts";

/** The CLI's failure kinds, and `contract` for a reply that breaks the shape the CLI promises. */
export type ErrorKind = "failed" | "unreachable" | "refused" | "not-found" | "conflict" | "invalid" | "contract";

/**
 * Why a publish or unpublish of a port waits for none: another one on the same port is running. The Claude Code
 * Nexus mod says the same.
 */
export const portBusy = (thread: string, port: number) => `Port ${port} on ${thread} is already being published or unpublished. Try again when it finishes.`;

/** A failed nexus command, with the kind the CLI reported. */
export class NexusError extends Error {
	constructor(readonly kind: ErrorKind, message: string) {
		super(message);
		this.name = "NexusError";
	}
}

/** A thread as one watch has seen it so far. */
export interface ThreadView {
	entries: readonly RenderedEntry[];
	/** Undefined until the first state event. */
	state?: ThreadState;
	/** The control plane's failure while it is down, cleared by the next state event. */
	outage?: string;
	/** Whether any state this watch reported had the run working. */
	sawWorking?: boolean;
	live?: LiveRun;
}

export const emptyView: ThreadView = { entries: [] };

/** `text` ending in a full stop; the CLI's messages end without one. */
const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

export function reduce(view: ThreadView, event: WatchEvent): ThreadView {
	switch (event.type) {
		case "reset":
			return { ...view, entries: event.entries };
		case "entry": {
			const entries = [...view.entries, { entry: event.entry, text: event.text }];
			// The CLI prints an answer's entry just before the live event that drops it from the partial answer. The
			// partial is that answer, so it goes now, and a draw between the two lines shows the answer once.
			const answered = view.live?.partial != null && event.entry.model?.some((m) => m.role === "assistant");
			return { ...view, entries, ...(answered ? { live: { ...view.live!, partial: null } } : {}) };
		}
		case "state": {
			const { type: _type, thread: _thread, ...state } = event;
			return {
				entries: view.entries,
				state,
				sawWorking: view.sawWorking === true || state.run === "working",
				...(view.live ? { live: view.live } : {}),
			};
		}
		case "live": {
			const { type: _type, thread: _thread, ...live } = event;
			return { ...view, live };
		}
		case "error":
			return {
				...view,
				outage: `${event.kind === "failed" ? "The control plane is failing" : "Nexus is unreachable"}: ${sentence(event.message)}`,
			};
	}
}

export const contentText = (content: string | readonly Part[]) =>
	typeof content === "string" ? content : content.map((p) => (p.type === "text" ? p.text : p.type === "image" ? "[image]" : "")).join("");

type Row = { kind: "user" | "assistant" | "tool" | "notice"; text?: string };

/**
 * The conversation as the rows a reader sees: a user's text, each assistant text part, each tool call, a notice for
 * a failed or aborted model and for an entry without messages. A tool result folds into its call's row.
 */
function rows(entries: readonly RenderedEntry[]): Row[] {
	return entries.flatMap(({ entry, text }): Row[] => {
		if (!entry.model) return text ? [{ kind: "notice" }] : [];
		return entry.model.flatMap((message): Row[] => {
			switch (message.role) {
				case "user": {
					const text = contentText(message.content).trim();
					return text ? [{ kind: "user", text }] : [];
				}
				case "assistant": {
					return [
						...message.content.flatMap((part): Row[] =>
							part.type === "text" && part.text.trim() ? [{ kind: "assistant", text: part.text.trim() }] : part.type === "toolCall" ? [{ kind: "tool" }] : [],
						),
						...(message.stopReason === "error" || message.stopReason === "aborted" ? [{ kind: "notice" as const }] : []),
					];
				}
				default:
					return [];
			}
		});
	});
}

/**
 * The agent is done for now. Either the thread cannot run on (archived, deleted, parked, or its pylon failed), or
 * its run is idle with nothing queued and either the last row is not the person's message or this watch saw the
 * run working first. A message just sent shows as queued or as a trailing user row, so it is not missed; a turn
 * aborted before it wrote any text leaves a trailing user row, which the working-then-idle run settles.
 */
export function isSettled(view: ThreadView): boolean {
	const state = view.state;
	if (state === undefined) return false;
	if (state.status === "archived" || state.status === "deleted" || state.run === "parked") return true;
	if (state.pylon === "failed" || state.failed !== null) return true;
	if (state.run !== "idle" || state.queued > 0) return false;
	const all = rows(view.entries);
	return view.sawWorking === true || (all.length > 0 && all.at(-1)!.kind !== "user");
}

/** The agent's text since the person's last message, its parts a blank line apart, or undefined when the latest turn wrote none. */
export function latestReply(entries: readonly RenderedEntry[]): string | undefined {
	const all = rows(entries);
	const asked = all.map((r) => r.kind).lastIndexOf("user");
	const texts = all.slice(asked + 1).flatMap((r) => (r.kind === "assistant" ? [r.text!] : []));
	return texts.length > 0 ? texts.join("\n\n") : undefined;
}

/** The last `max` characters of `text`, cut at a line where it can be, saying what was left out. */
export function keepTail(text: string, max: number): string {
	if (text.length <= max) return text;
	const cut = text.slice(-max);
	const line = cut.indexOf("\n");
	return `[${text.length - max} earlier characters left out]\n${line >= 0 && line < max / 4 ? cut.slice(line + 1) : cut}`;
}

/** The CLI's rendering of each entry, newest last, kept to its last `max` characters. */
export const transcript = (entries: readonly RenderedEntry[], max: number) =>
	keepTail(entries.map((e) => e.text).filter(Boolean).join("\n\n") || "No messages yet.", max);

/** How a prompt that did not come from the person reads, as the CLI marks it. */
export const promptLabel = (from: string) => (from === "person" ? "" : from === "command" ? "[slash command] " : "[Claude Code] ");

/**
 * The messages Claude Code queued and has not taken, oldest first, as the control plane reads them. A removal names
 * the message it takes by its text, or names none and takes the oldest.
 */
export function claudeQueued(entries: readonly ClaudeEntry[]): (string | null)[] {
	const queued: (string | null)[] = [];
	for (const entry of entries) {
		if (entry.kind !== "queue") continue;
		if (entry.op === "enqueue") queued.push(entry.text);
		else {
			const taken = entry.text === null ? 0 : queued.indexOf(entry.text);
			if (taken !== -1) queued.splice(taken, 1);
		}
	}
	return queued;
}

/** What a Claude worker's transcript with nothing to show says. */
export const claudeUnwritten = (c: ClaudeConversation) =>
	c.readAt === null ? "Claude's transcript has not been read yet. It is read while the pylon runs." : "Claude has not written a transcript yet.";

/**
 * A Claude worker's transcript as the CLI's text renders it, with each tool's and background task's output under it, as
 * the Claude Code Nexus mod gives it, and a result whose call the window dropped on its own, kept to its last `max`
 * characters.
 */
export function claudeTranscript(c: ClaudeConversation, max: number): string {
	const results = new Map(c.entries.flatMap((e) => (e.kind === "result" ? [[e.toolUseId, e] as const] : [])));
	const calls = new Set(c.entries.flatMap((e) => (e.kind === "tool" ? [e.id] : [])));
	const lastTurn = c.entries.map((e) => e.kind).lastIndexOf("turn");
	const pullRequests = new Set<string>();
	const lines = c.entries.flatMap((e, i): string[] => {
		switch (e.kind) {
			case "prompt":
				return [`> ${promptLabel(e.from)}${e.text.split("\n").join("\n> ")}`];
			case "reply":
				return [e.text];
			case "result":
				if (calls.has(e.toolUseId)) return [];
				return [`[tool result] (${e.isError ? "failed" : "ok"})${e.output.trimEnd() ? `\n${e.output.trimEnd()}` : ""}`];
			case "tool": {
				const result = results.get(e.id);
				const how = result !== undefined ? (result.isError ? "failed" : "ok") : c.working && i > lastTurn ? "running" : "no result";
				const input = JSON.stringify(e.input);
				const output = result?.output.trimEnd();
				return [`[tool] ${e.name} ${input.length <= 200 ? input : `${input.slice(0, 200)}...`} (${how})${output ? `\n${output}` : ""}`];
			}
			case "task":
				return [`[task] ${e.status}: ${e.summary}${e.result?.trim() ? `\n${e.result.trimEnd()}` : ""}`];
			case "notice":
				return [`[${e.tone === "error" ? "error" : "notice"}] ${e.text}`];
			case "turn":
				return [`[turn] ${Math.round(e.durationMs / 1000)}s`];
			case "pull-request":
				if (pullRequests.has(e.url)) return [];
				pullRequests.add(e.url);
				return [`[pull request] Opened pull request #${e.number}: ${e.url}`];
			case "record":
				return [`[record] ${e.type}: ${e.summary}`];
			default:
				return [];
		}
	});
	const parts = [
		...(c.dropped === 0 ? [] : [`(${c.dropped} older entries are not kept)`]),
		...lines,
		...claudeQueued(c.entries).map((q) => `(queued) > ${q ?? ""}`),
		...(c.working ? ["(Claude is working)"] : []),
	];
	return keepTail(parts.length > 0 ? parts.join("\n\n") : claudeUnwritten(c), max);
}

/** A Claude worker thread's state for the model tools, from its details and its transcript, as a watch's `state` reports a Nexus agent's. */
export const claudeState = (detail: ThreadDetail, c: ClaudeConversation): ThreadState => ({
	status: detail.thread.status,
	run: detail.agent?.parkedTasks ? "parked" : c.working ? "working" : "idle",
	parkedTasks: detail.agent?.parkedTasks ?? 0,
	queued: claudeQueued(c.entries).length,
	pylon: detail.pylon.actualState,
	failed: detail.pylon.failed,
	ports: detail.ports,
});

/** Whether a Claude worker is done for good: it can no longer run (archived, deleted, parked, a failed pylon) or its launch failed or stalled. */
export function hasWorkerEnded(detail: ThreadDetail, c: ClaudeConversation): boolean {
	const state = claudeState(detail, c);
	if (state.status === "archived" || state.status === "deleted" || state.run === "parked" || state.pylon === "failed" || state.failed !== null) return true;
	return detail.claudeWorker?.state === "failed" || detail.claudeWorker?.state === "stalled";
}

/** The transcript entry kinds that show a turn: a prompt Claude took, a reply, a tool call or a turn's end. */
const turnKinds = new Set(["prompt", "reply", "tool", "turn"]);

/**
 * Whether a Claude worker's turn is over with nothing queued, even when the transcript ends at a prompt it never
 * answered. Only a launch that is `started` with a turn to show for it, in the transcript or as `sawWorking` says the
 * caller saw it run, counts, since a worker still launching is idle with nothing in its transcript.
 */
export function isWorkerIdle(detail: ThreadDetail, c: ClaudeConversation, sawWorking: boolean): boolean {
	const launched = detail.claudeWorker?.state === "started" && (sawWorking || c.dropped > 0 || c.entries.some((e) => turnKinds.has(e.kind)));
	const state = claudeState(detail, c);
	return launched && state.run === "idle" && state.queued === 0;
}

/** Claude's replies since the person's last prompt, a blank line apart, or undefined when the latest turn wrote none. */
export function claudeReply(c: ClaudeConversation): string | undefined {
	const asked = c.entries.map((e) => e.kind === "prompt" && e.from !== "other" && e.text.trim() !== "").lastIndexOf(true);
	const texts = c.entries.slice(asked + 1).flatMap((e) => (e.kind === "reply" && e.text.trim() ? [e.text.trim()] : []));
	return texts.length > 0 ? texts.join("\n\n") : undefined;
}

export function stateLine(state: ThreadState): string {
	const run =
		state.run === "working" ? "agent working" : state.run === "parked" ? `${state.parkedTasks} parked tasks hold the run` : "agent idle";
	return [
		state.status,
		run,
		`pylon ${state.pylon}${state.failed === null ? "" : ` failed: ${state.failed}`}`,
		...(state.queued === 0 ? [] : [`${state.queued} queued`]),
	].join(", ");
}

export function threadRows(threads: readonly Thread[]): string {
	if (threads.length === 0) return "No threads.";
	const rows = threads.map((t) => [t.id, t.status, t.agentTurnRunning ? "working" : "-", t.project, t.title]);
	const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
	return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]!))).join("  ")).join("\n");
}

/**
 * Whether the thread's agent works: a Nexus agent's turn, or a session's, a Claude worker's included. Attention is no
 * help once a reply is unread, since an unread reply outranks working there.
 */
export const isWorking = (t: Pick<ThreadRow, "agentTurnRunning" | "sessionTurnRunning" | "attention">) => t.agentTurnRunning || t.sessionTurnRunning === true || t.attention === "working";

export const workingCount = (threads: readonly ThreadRow[]) =>
	threads.filter((t) => isWorking(t) && t.status !== "deleted").length;

export const lastActivityAt = (t: Thread) => Math.max(t.lastAgentActivityAt, t.lastHumanActivityAt, t.createdAt);

export function ago(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}

const fullId = /^th-[0-9a-f]{12}$/;

/** True when `ref` is already a whole thread ID, so it needs no lookup. */
export const isThreadId = (ref: string) => fullId.test(ref);

/** The IDs among `ids` that start with `ref`, with or without its `th-`. */
export function matchingIds(ref: string, ids: readonly string[]): string[] {
	const hex = ref.startsWith("th-") ? ref.slice(3) : ref;
	if (!/^[0-9a-f]+$/.test(hex)) throw new NexusError("failed", `${ref} is not a thread ID or a prefix of one.`);
	return ids.filter((id) => id.slice(3).startsWith(hex));
}

const ambiguous = (ref: string, found: readonly string[]) =>
	new NexusError("failed", `${ref} matches ${found.length} threads: ${found.slice(0, 5).join(", ")}.`);

/** The one ID among `ids` that starts with `ref`, with or without its `th-`. */
export function resolveThread(ref: string, ids: readonly string[]): string {
	if (isThreadId(ref)) return ref;
	const found = matchingIds(ref, ids);
	if (found.length === 1) return found[0]!;
	if (found.length === 0) throw new NexusError("failed", `no thread starts with ${ref}`);
	throw ambiguous(ref, found);
}

/** The one ID among `ids` that starts with `ref`, or undefined when none does. */
export function findThread(ref: string, ids: readonly string[]): string | undefined {
	const found = matchingIds(ref, ids);
	if (found.length > 1) throw ambiguous(ref, found);
	return found[0];
}
