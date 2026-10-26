/**
 * What pi-nexus makes of a Nexus thread, from the shapes in contract.ts. The settle rule, the trims and the thread
 * matching match the Claude Code Nexus mod's hooks/model.ts, so both agents behave the same.
 */
import type { LiveRun, Part, RenderedEntry, Thread, ThreadRow, ThreadState, WatchEvent } from "./contract.ts";

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

/** Whether the thread's agent works: a Nexus agent's turn, or, by the control plane's attention, a Claude worker's. */
export const isWorking = (t: Pick<ThreadRow, "agentTurnRunning" | "attention">) => t.agentTurnRunning || t.attention === "working";

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
