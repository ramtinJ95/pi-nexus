/**
 * What the console shows of Nexus, as plain functions of what the CLI reports. It follows the web dashboard,
 * src/control/dashboard.ts in the nexus repo, so a thread reads the same in both: the same state labels, the same
 * folds, the same run bar and the same reasons a thread takes no messages.
 */
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, DesiredPhase, ListeningPort, LiveRun, OpenedSession, Preview, Project, RenderedEntry, Session, Thread, ThreadDetail, ThreadRow, ThreadState, ThreadStatus, ToolCallPart, ToolResultMessage } from "../contract.ts";
import { contentText, lastActivityAt, portBusy, workingCount } from "../thread.ts";

/** The colour of a status dot. `work` is an agent mid-turn, `busy` a pylon changing phase. */
export type Tone = "ok" | "work" | "busy" | "idle" | "bad" | "muted";
export const toneColor: Readonly<Record<Tone, ThemeColor>> = {
	ok: "success",
	work: "accent",
	busy: "warning",
	idle: "muted",
	bad: "error",
	muted: "dim",
};

const actualBadge: Readonly<Record<string, [label: string, tone: Tone]>> = {
	running: ["running", "ok"],
	spawning: ["spawning", "busy"],
	pausing: ["pausing", "busy"],
	deleting: ["deleting", "busy"],
	paused: ["paused", "idle"],
	absent: ["not on its node", "muted"],
	failed: ["failed", "bad"],
	unknown: ["unknown", "muted"],
};
export const badge = (actual: string): [label: string, tone: Tone] => actualBadge[actual] ?? [actual, "muted"];
export const desiredTone: Readonly<Record<DesiredPhase, Tone>> = { running: "ok", paused: "idle", deleted: "muted" };
export const sessionTone: Readonly<Record<string, Tone>> = { working: "work", idle: "idle", blocked: "bad", done: "ok", unknown: "muted" };
export const harnessLabel: Readonly<Record<string, string>> = { "claude-code": "Claude Code", pi: "pi", shell: "Shell" };

/** The command that attaches a terminal on this Mac to the thread's pylon, through the CLI `cli` names, as a shell takes it. */
export const attachCommand = (cli: string, thread: string) => `${shellQuote(cli)} attach ${shellQuote(thread)}`;
/** `word` as one word to a POSIX shell or zsh: bare when nothing in it is special, else single-quoted. */
export const shellQuote = (word: string) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);
export const attachHint = "Attaching needs Nexus CLI 0.9.0 or newer and goes through the control plane.";

/** A session as a person names it: its harness, and its title when it has one, such as `Claude Code "login"`. */
export const sessionName = (harness: string, title: string | null | undefined) =>
	`${harnessLabel[harness] ?? harness}${title ? ` "${title}"` : ""}`;

/** When a paused session comes back: with the pylon's next wake, or an archived thread's unarchive. */
const resumesOn = (thread: ThreadStatus) => (thread === "archived" ? "unarchive" : "wake");

/**
 * A session's state as its row reads it: a running one by Herdr's status, a paused one by when it comes back, and a
 * failed one as failed, its message apart.
 */
export function sessionLook(s: Session, thread: ThreadStatus): [label: string, tone: Tone] {
	if (s.state === "paused") return [`paused, resumes on ${resumesOn(thread)}`, "idle"];
	if (s.state === "failed") return ["failed", "bad"];
	return [s.status, sessionTone[s.status] ?? "muted"];
}

/** Why a paused session cannot be closed yet, as the control plane refuses it. */
export const pausedRefusal = (s: Session, thread: ThreadStatus) =>
	`${sessionName(s.harness, s.title)} is paused with the pylon and resumes on ${resumesOn(thread)}. Close it once it runs.`;

/** Where a session is, as a sentence names it: its pane, or its ID when it has none. */
export const sessionPlace = (s: Session) => (s.herdrPane === null ? `session ${s.id}` : `pane ${s.herdrPane}`);

/**
 * Whether `a` and `b` are one session. Two harness session IDs decide it, since a wake can bring a session back in
 * another pane, and Herdr gives a closed pane's ID to a later session, which may have the same harness and title.
 * Without both, it is the same ID with the same harness and title. A title missing from either, as from a control
 * plane older than titles, matches any.
 */
export const sameSession = (a: Session, b: Session) =>
	a.harnessSessionId !== null && b.harnessSessionId !== null
		? a.harnessSessionId === b.harnessSessionId
		: a.id === b.id && a.harness === b.harness && (a.title == null || b.title == null || a.title === b.title);

/** A session just opened, as a row shows it until the node reports it. */
const openedSession = (session: OpenedSession): Session => ({ ...session, id: session.herdrPane, state: "running", message: null, status: "opened", harnessSessionId: null });

/**
 * How long an open or close confirmed in the thread view outweighs details that do not show it. The node reads its
 * sessions again once the CLI has answered, so the next details can still show them as they were.
 */
export const sessionSettleMs = 30_000;

/**
 * An open the CLI confirmed, with the sessions the details listed then, by ID and harness session ID, or null when
 * no details had been read.
 */
export interface Opened {
	session: OpenedSession;
	at: number;
	before: { ids: string[]; harnessSessionIds: string[] } | null;
}

/**
 * What the person did to the thread's sessions from the thread view: the opens and closes under way, the closes by
 * session ID, and those confirmed that the details have not shown yet, each with when it was confirmed.
 */
export interface SessionChanges {
	opening: { harness: string; title: string | undefined }[];
	opened: Opened[];
	closing: Set<string>;
	closed: { session: Session; at: number }[];
}
export const noSessionChanges = (): SessionChanges => ({ opening: [], opened: [], closing: new Set(), closed: [] });

/** Records an open the CLI confirmed, and what `listed`, the details read last, held then. */
export function confirmOpened(changes: SessionChanges, session: OpenedSession, listed: readonly Session[] | undefined, now: number): void {
	const before = listed === undefined ? null : { ids: listed.map((s) => s.id), harnessSessionIds: listed.flatMap((s) => (s.harnessSessionId === null ? [] : [s.harnessSessionId])) };
	changes.opened.push({ session, at: now, before });
}

/** Records a close the CLI confirmed. A session just opened and now closed is forgotten, whatever the details say next. */
export function confirmClosed(changes: SessionChanges, session: Session, now: number): void {
	changes.closed.push({ session, at: now });
	changes.opened = changes.opened.filter((o) => !sameSession(openedSession(o.session), session));
}

/**
 * The opens that `sessions` list, each against a session of its own. An open is listed in its own pane, checked first,
 * unless the session there has a harness session ID listed before the open, which makes it the pane's earlier session
 * in stale details. A wake can move the new session to another pane, so an open is also listed by a session of its
 * harness and title whose harness session ID and ID were both not listed before. A session with no harness session ID
 * could be an older one that moved, so it lists an open only in its pane. An open nothing lists, or one the details
 * cannot tell from another, keeps its row until `sessionSettleMs`.
 */
function listedOpens(opens: readonly Opened[], sessions: readonly Session[]): Set<Opened> {
	const taken = new Set<Session>();
	const listed = new Set<Opened>();
	const claim = (open: Opened, matches: (s: Session) => boolean) => {
		const session = sessions.find((s) => !taken.has(s) && matches(s));
		if (session === undefined) return;
		taken.add(session);
		listed.add(open);
	};
	const before = (open: Opened, s: Session) => s.harnessSessionId !== null && open.before?.harnessSessionIds.includes(s.harnessSessionId) === true;
	for (const open of opens) claim(open, (s) => s.herdrPane === open.session.herdrPane && !before(open, s));
	for (const open of opens) {
		if (listed.has(open) || open.before === null) continue;
		const { ids } = open.before;
		claim(open, (s) => s.harnessSessionId !== null && !before(open, s) && !ids.includes(s.id) && s.harness === open.session.harness && s.title === open.session.title);
	}
	return listed;
}

/** Forgets the confirmations that `sessions`, just read, show, or that have waited `sessionSettleMs` for it. */
export function settleSessions(changes: SessionChanges, sessions: readonly Session[], now: number): void {
	const opens = listedOpens(changes.opened, sessions);
	changes.opened = changes.opened.filter((o) => !opens.has(o) && now - o.at < sessionSettleMs);
	changes.closed = changes.closed.filter(({ session, at }) => sessions.some((s) => sameSession(s, session)) && now - at < sessionSettleMs);
}

/**
 * The sessions as the details list them, with the confirmations they do not show yet: a session just closed is gone,
 * and a session just opened is there, `opened` until the node reports it.
 */
export function shownSessions(sessions: readonly Session[], changes: SessionChanges): Session[] {
	const closed = (session: Session) => changes.closed.some((c) => sameSession(session, c.session));
	const opens = listedOpens(changes.opened, sessions);
	const opened = changes.opened.filter((o) => !opens.has(o)).map((o) => openedSession(o.session)).filter((o) => !closed(o));
	return [...sessions.filter((s) => !closed(s)), ...opened];
}

/**
 * What a thread is doing, most urgent first: the agent mid-turn hides a running pylon, never a failed one. `actual`
 * is the pylon's observed state, and `working` whether its agent works, which a Claude worker's turn is too.
 */
export function threadState(t: Thread, actual: string, working = t.agentTurnRunning): [label: string, tone: Tone] {
	if (t.status === "archived" || t.status === "deleted") return [t.status, "muted"];
	if (working && actual !== "failed") return ["agent working", "work"];
	return badge(actual);
}

/** "5 min", or null under 45 seconds. */
export function span(at: number, now: number): string | null {
	const seconds = Math.max(0, Math.round((now - at) / 1000));
	return seconds < 45
		? null
		: seconds < 45 * 60
			? `${Math.round(seconds / 60)} min`
			: seconds < 36 * 3600
				? `${Math.round(seconds / 3600)} h`
				: `${Math.round(seconds / 86_400)} d`;
}

export function ago(at: number | undefined, now: number): string {
	if (at === undefined || at === 0) return "never";
	const label = span(at, now);
	return label === null ? "just now" : `${label} ago`;
}

/** A run's length as a clock reads it, such as 1m 12s. */
export function clock(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export const isClosed = (t: Thread) => t.status === "archived" || t.status === "deleted";

export function closedLabel(threads: readonly Thread[]): string {
	const deleted = threads.filter((t) => t.status === "deleted").length;
	const archived = threads.length - deleted;
	return [archived > 0 && `${archived} archived`, deleted > 0 && `${deleted} deleted`].filter(Boolean).join(", ");
}

export interface Group {
	project: string;
	open: ThreadRow[];
	closed: ThreadRow[];
}

/** Each project's threads, newest first, the open ones apart from the archived or deleted ones. */
export function groups(threads: readonly ThreadRow[], projects: readonly Project[]): Group[] {
	const names = [...new Set([...projects.map((p) => p.id), ...threads.map((t) => t.project)])];
	const newest = [...threads].sort((a, b) => b.createdAt - a.createdAt);
	return names.map((project) => {
		const own = newest.filter((t) => t.project === project);
		return { project, open: own.filter((t) => !isClosed(t)), closed: own.filter(isClosed) };
	});
}

/** What a thread's marker says: it needs the person, it has a reply they have not seen, or its agent works. */
export type Mark = "needs-you" | "new" | "working";

/**
 * The control plane's attention as a marker. Only the person can retry a failed pylon or parked tasks, or answer a
 * session waiting for input. An attention value this table does not know shows no marker.
 */
const marks: Readonly<Record<string, Mark>> = { failed: "needs-you", parked: "needs-you", waiting: "needs-you", reply: "new", working: "working" };

/** An archived or deleted thread wants nothing. */
export const markOf = (t: ThreadRow): Mark | null =>
	isClosed(t) || t.attention === null || !Object.hasOwn(marks, t.attention) ? null : marks[t.attention]!;

/** Whether the latest reply came after anyone, in any client, last marked it seen. */
export const unread = (t: Pick<ThreadRow, "seenAt" | "lastReplyAt">) => t.lastReplyAt !== null && (t.seenAt === null || t.lastReplyAt > t.seenAt);

/**
 * The status line's summary of the threads in scope, such as `nexus 2 working · 1 needs you · 3 new`, or
 * `nexus spoon · 1 working` for one project. The counts other than working show when not zero.
 */
export function summary(threads: readonly ThreadRow[], project: string | null = null): string {
	const count = (mark: Mark) => threads.filter((t) => markOf(t) === mark).length;
	const needs = count("needs-you");
	const fresh = count("new");
	return [
		`nexus ${project === null ? "" : `${project} · `}${workingCount(threads)} working`,
		...(needs > 0 ? [`${needs} needs you`] : []),
		...(fresh > 0 ? [`${fresh} new`] : []),
	].join(" · ");
}

/** A thread in the strip above pi's editor: one that needs you, has news, or works, in that order. */
export interface Chip {
	thread: ThreadRow;
	kind: Mark;
}

const chipOrder: Readonly<Record<Mark, number>> = { "needs-you": 0, new: 1, working: 2 };

export function chips(threads: readonly ThreadRow[]): Chip[] {
	return threads
		.flatMap((thread): Chip[] => {
			const kind = markOf(thread);
			return kind === null ? [] : [{ thread, kind }];
		})
		.sort((a, b) => chipOrder[a.kind] - chipOrder[b.kind] || lastActivityAt(b.thread) - lastActivityAt(a.thread));
}

export type PickerRow =
	| { kind: "new" }
	| { kind: "project"; project: string; count: number }
	| { kind: "thread"; thread: ThreadRow }
	| { kind: "fold"; project: string; label: string; open: boolean };

/**
 * The picker's rows. A project's closed threads fold under one row, which `unfolded` opens. A filter matches a
 * thread's title or ID, hides the projects with no match and opens a fold that holds one.
 */
export function pickerRows(all: readonly Group[], unfolded: ReadonlySet<string>, query: string): PickerRow[] {
	const q = query.trim().toLowerCase();
	const match = (t: Thread) => q === "" || t.title.toLowerCase().includes(q) || t.id.includes(q);
	const rows: PickerRow[] = q === "" ? [{ kind: "new" }] : [];
	for (const g of all) {
		const open = g.open.filter(match);
		const closed = g.closed.filter(match);
		if (q !== "" && open.length === 0 && closed.length === 0) continue;
		rows.push({ kind: "project", project: g.project, count: g.open.length });
		rows.push(...open.map((thread) => ({ kind: "thread" as const, thread })));
		if (closed.length === 0) continue;
		const opened = q !== "" || unfolded.has(g.project);
		rows.push({ kind: "fold", project: g.project, label: closedLabel(closed), open: opened });
		if (opened) rows.push(...closed.map((thread) => ({ kind: "thread" as const, thread })));
	}
	return rows;
}

/**
 * A tool result made for display rather than received: a running call's output so far, or the failure an aborted or
 * failed answer gives its calls, as pi's replay does. No tool sent it, so it has no call ID.
 */
export type ShownResult = { role: "toolResult"; content: ToolResultMessage["content"]; isError: boolean; details?: unknown };
/** The answer streaming now, which has no stop reason or model until it is committed. */
export type StreamingAnswer = { role: "assistant"; content: AssistantMessage["content"] };

export type ToolResult = { state: "done"; message: ToolResultMessage | ShownResult } | { state: "running"; output: string } | { state: "none" };

/** One row of the conversation. A tool call carries its result, which the transcript holds in a later entry. */
export type Item =
	| { kind: "user"; key: string; text: string; at: number }
	| { kind: "assistant"; key: string; message: AssistantMessage | StreamingAnswer; streaming: boolean }
	| { kind: "tool"; key: string; call: ToolCallPart; result: ToolResult };
export type ToolItem = Extract<Item, { kind: "tool" }>;

/**
 * The entries' messages in the order pi draws a session: a user message, an assistant message, then its tool calls,
 * each with its result. A call in an aborted or failed answer gets that failure as its result, as pi's replay does.
 * A call with no result is running when the live run reports its output, even an empty one. Then the streaming
 * answer.
 */
export function conversationItems(entries: readonly RenderedEntry[], live: LiveRun | undefined): Item[] {
	const items: Item[] = [];
	const tools = new Map<string, ToolItem>();
	for (const { entry } of entries) {
		for (const [i, message] of (entry.model ?? []).entries()) {
			const key = `${entry.id}:${i}`;
			if (message.role === "user") {
				const text = contentText(message.content);
				if (text.trim() !== "") items.push({ kind: "user", key, text, at: message.timestamp });
			} else if (message.role === "assistant") {
				items.push({ kind: "assistant", key, message, streaming: false });
				const failed = message.stopReason === "aborted" ? "Operation aborted" : message.stopReason === "error" ? message.errorMessage || "Error" : null;
				for (const part of message.content) {
					if (part.type !== "toolCall") continue;
					const tool: ToolItem = {
						kind: "tool",
						key: part.id,
						call: part,
						result: failed === null ? { state: "none" } : { state: "done", message: { role: "toolResult", content: [{ type: "text" as const, text: failed }], isError: true } },
					};
					tools.set(part.id, tool);
					items.push(tool);
				}
			} else if (message.role === "toolResult") {
				const tool = tools.get(message.toolCallId);
				if (tool !== undefined && tool.result.state === "none") tool.result = { state: "done", message };
			}
		}
	}
	const outputs = new Map((live?.tools ?? []).map((t) => [t.callId, t.output]));
	for (const tool of tools.values()) {
		if (tool.result.state !== "none") continue;
		const output = outputs.get(tool.key);
		if (output !== undefined) tool.result = { state: "running", output };
	}
	if (live?.partial) {
		items.push({ kind: "assistant", key: "partial", message: { role: "assistant", content: [{ type: "text", text: live.partial }] }, streaming: true });
	}
	return items;
}

/** A run of tool calls this long folds into one line, so a busy turn does not bury the answer around it. */
export const foldAt = 4;

export type Block = Exclude<Item, ToolItem> | ToolItem | { kind: "steps"; key: string; tools: ToolItem[] };

/** An answer with nothing to read, such as one that only calls tools, does not break a run of tool calls. */
const blank = (item: Item) =>
	item.kind === "assistant" &&
	!item.streaming &&
	"stopReason" in item.message &&
	(item.message.stopReason === "toolUse" || item.message.stopReason === "stop") &&
	item.message.content.every(
		(part) => part.type === "toolCall" || (part.type === "text" && !part.text.trim()) || (part.type === "thinking" && !part.thinking.trim()),
	);

export function blocks(items: readonly Item[]): Block[] {
	const out: Block[] = [];
	let run: ToolItem[] = [];
	const flush = () => {
		if (run.length >= foldAt) out.push({ kind: "steps", key: `steps:${run[0]!.key}`, tools: run });
		else out.push(...run);
		run = [];
	};
	for (const item of items) {
		if (item.kind === "tool") run.push(item);
		else if (blank(item)) out.push(item);
		else {
			flush();
			out.push(item);
		}
	}
	flush();
	return out;
}

export const failed = ({ result }: ToolItem) => result.state === "done" && result.message.isError;
export const running = ({ result }: ToolItem) => result.state === "running";

/** pi's bash tool ends a failed command's output with its exit code. */
export const exitCode = (output: string) => /exited with code (\d+)/.exec(output)?.[1];

const subjectKeys = ["command", "pattern", "path", "url"];
const verbs: Readonly<Record<string, string>> = { read: "read", bash: "ran", edit: "edited", write: "wrote", grep: "searched", find: "found", ls: "listed" };

/** A step as the fold names it: read total.ts, ran npm test. */
export function stepName({ call }: ToolItem): string {
	const key = subjectKeys.find((k) => typeof call.arguments?.[k] === "string");
	const value = key === undefined ? "" : String(call.arguments[key]);
	const short = key === "command" ? value.trim().split(/\s+/).slice(0, 2).join(" ") : key === "path" ? value.split("/").at(-1)! : value;
	return `${verbs[call.name] ?? call.name} ${short}`.trim();
}

export interface StepsSummary {
	count: number;
	names: string;
	failed: number;
	running: number;
	/** The first failed step's exit code, for a fold that hides it. */
	exit?: string;
}

export function stepsSummary(tools: readonly ToolItem[]): StepsSummary {
	const bad = tools.filter(failed);
	const first = bad[0]?.result;
	const exit = first?.state === "done" ? exitCode(contentText(first.message.content)) : undefined;
	return {
		count: tools.length,
		names: [...new Set(tools.map(stepName))].join(", "),
		failed: bad.length,
		running: tools.filter(running).length,
		...(exit === undefined ? {} : { exit }),
	};
}

const isEdit = (e: unknown): e is { oldText: string; newText: string } =>
	typeof e === "object" && e !== null && typeof (e as { oldText?: unknown }).oldText === "string" && typeof (e as { newText?: unknown }).newText === "string";

/** The diff of an edit, from its arguments, in the line format pi's renderDiff reads, without line numbers. */
export function argumentsDiff(call: ToolCallPart): string | undefined {
	const edits = call.arguments?.edits;
	if (call.name !== "edit" || !Array.isArray(edits) || edits.length === 0 || !edits.every(isEdit)) return undefined;
	const lines = (sign: string, text: string) => text.split("\n").map((line) => `${sign} ${line}`);
	return edits.flatMap((e) => [...lines("-", e.oldText), ...lines("+", e.newText)]).join("\n");
}

/**
 * What pi's tool component draws as a call's result: the stored result, as it is, once there is one, or else a
 * partial one with the output so far. An edit with no result yet shows the diff of its arguments, as pi shows a
 * pending edit; a finished one never gets a made-up diff. Undefined when the call has nothing to draw yet.
 */
export function shownResult(tool: ToolItem): { message: ToolResultMessage | ShownResult; partial: boolean } | undefined {
	const result = tool.result;
	if (result.state === "done") return { message: result.message, partial: false };
	const diff = argumentsDiff(tool.call);
	if (result.state === "none" && diff === undefined) return undefined;
	const content = result.state === "running" ? [{ type: "text" as const, text: result.output }] : [];
	return { message: { role: "toolResult", content, isError: false, ...(diff === undefined ? {} : { details: { diff } }) }, partial: true };
}

export type Run = { kind: "idle" } | { kind: "working"; since?: number; tools: number } | { kind: "parked"; tasks: number };

/**
 * What the agent's run is doing. A parked run is stuck, not working. A working run is timed from the message it
 * answers, since Nexus keeps no start time for a run.
 */
export function runOf(state: ThreadState | undefined, items: readonly Item[]): Run {
	if (state?.run === "parked") return { kind: "parked", tasks: state.parkedTasks };
	if (state?.run !== "working") return { kind: "idle" };
	const asked = items.map((i) => i.kind).lastIndexOf("user");
	const since = asked === -1 ? undefined : (items[asked] as Extract<Item, { kind: "user" }>).at;
	const tools = items.slice(asked + 1).filter((i) => i.kind === "tool").length;
	return { kind: "working", tools, ...(since === undefined ? {} : { since }) };
}

export function workingMessage(run: Extract<Run, { kind: "working" }>, now: number, archived: boolean): string {
	return [
		"Working",
		...(run.since === undefined ? [] : [clock(now - run.since)]),
		`${run.tools} ${run.tools === 1 ? "tool" : "tools"} this turn`,
		...(archived ? [] : ["new messages queue"]),
	].join(" · ");
}

export const parkedMessage = (tasks: number, archived: boolean) =>
	`${tasks} ${tasks === 1 ? "task" : "tasks"} hit the restart limit and hold the run. ${archived ? "Unarchive the thread to retry them." : "/retry runs them again."}`;

/** Why a thread takes no messages, or that it takes them. */
export type Composer =
	| { kind: "closed"; reason: string }
	| { kind: "failed"; failed: string; refused: string | null }
	| { kind: "archived" }
	| { kind: "open"; paused: boolean };

/**
 * Only the planner giving up holds the pylon until a human acts; a pylon the probe reports broken may still be paused
 * and resumed. The watch's state is newer than the detail, so it decides the status and the failure.
 */
export function composerOf(state: ThreadState | undefined, detail: ThreadDetail | undefined): Composer {
	const status = state?.status ?? detail?.thread.status;
	if (status === "deleted") return { kind: "closed", reason: "The thread is deleted, so its conversation is gone." };
	if (detail?.thread.conversationId === null) return { kind: "closed", reason: "This thread has no agent conversation." };
	const gaveUp = state === undefined ? (detail?.pylon.failed ?? null) : state.failed;
	if (gaveUp !== null) return { kind: "failed", failed: gaveUp, refused: detail?.pylon.retryRefused ?? null };
	if (status === "archived") return { kind: "archived" };
	return { kind: "open", paused: (state?.pylon ?? detail?.pylon.actualState) === "paused" };
}

export const failedText = (refused: string | null) =>
	`The planner gave up on this thread's pylon, so its agent cannot run tools and the thread takes no messages. ${
		refused !== null
			? `${refused}.`
			: "Fix the cause, such as the project's git access, and /retry-pylon, or /start-again from the same project. A retry runs setup again on a new pylon whose setup failed, and resumes a broken pylon from its newest disk."
	}`;

export const archivedText = "An archived thread takes no messages, because its pylon stays paused. /unarchive to send one.";
export const pausedText = "The pylon is paused. Sending a message wakes it.";

/** The model of the newest committed answer, which is the one the next message goes to. */
export function modelOf(entries: readonly RenderedEntry[]): string | undefined {
	const answers = entries.flatMap((e) => e.entry.model ?? []).filter((m): m is AssistantMessage => m.role === "assistant" && m.model !== "");
	return answers.at(-1)?.model;
}

/**
 * The outputs worth listing. A preview output repeats a preview the thread lists, so it stays only for a preview the
 * thread no longer lists, which the dashboard keeps too.
 */
export const shownOutputs = (detail: ThreadDetail) =>
	detail.outputs.filter((o) => o.kind !== "preview" || !detail.previews.some((p) => p.service === o.ref));

/**
 * What the person did to a port from this view, as the Claude Code mod keeps it: the publication its last operation
 * confirmed, with its place in the view's order of events, apart from an operation under way and the last one's failure.
 */
export interface PortChange {
	/** The port's preview, or null once unpublished, and the view's mark when that was confirmed. */
	confirmed: { preview: Preview | null; at: number } | null;
	pending: "open" | "close" | null;
	failure: { action: "open" | "close"; message: string } | null;
}
export const noChange: PortChange = { confirmed: null, pending: null, failure: null };

/** The port of a preview that publishes a port on its own, which Nexus names `port-<port>`. Undefined for a service's. */
export function linkedPort(service: string): number | undefined {
	const port = /^port-(\d+)$/.exec(service)?.[1];
	return port === undefined ? undefined : Number(port);
}

/**
 * The previews and ports as the details list them, with what the person confirmed since: a port just unpublished has
 * no preview, and one just published has its own. A confirmation counts until details asked for after it show the
 * port as it is. `askedAt` and a confirmation's `at` are marks in one sequence, so they never tie.
 */
export function shownPorts(
	detail: Pick<ThreadDetail, "previews" | "ports">,
	changes: ReadonlyMap<number, PortChange>,
	askedAt: number,
): Pick<ThreadDetail, "previews" | "ports"> {
	const confirmed = (port: number | undefined) => {
		const known = port === undefined ? null : (changes.get(port)?.confirmed ?? null);
		return known !== null && known.at > askedAt ? known : null;
	};
	const listed = detail.previews.flatMap((p) => {
		const known = confirmed(linkedPort(p.service));
		return known === null ? [p] : known.preview === null ? [] : [known.preview];
	});
	const published = [...changes.keys()].flatMap((port) => {
		const preview = confirmed(port)?.preview;
		return preview && !listed.some((p) => p.service === preview.service) ? [preview] : [];
	});
	const ports = detail.ports && detail.ports.map((p) => {
		const known = confirmed(p.port);
		return known === null ? p : { ...p, preview: known.preview };
	});
	return { previews: [...listed, ...published], ports };
}

/**
 * A row of the Ports view: a preview, with the port it serves when the ports say, or a port that listens with no
 * preview. Each port shows once.
 */
export type PortRow = { kind: "preview"; preview: Preview; port: number | undefined } | { kind: "port"; port: ListeningPort };

export function portRows({ previews, ports }: Pick<ThreadDetail, "previews" | "ports">): PortRow[] {
	const portOf = new Map((ports ?? []).flatMap((p) => (p.preview ? [[p.preview.service, p.port] as const] : [])));
	return [
		...previews.map((preview): PortRow => ({ kind: "preview", preview, port: linkedPort(preview.service) ?? portOf.get(preview.service) })),
		...(ports ?? []).filter((p) => p.preview === null).map((port): PortRow => ({ kind: "port", port })),
	];
}

/**
 * What publishing (Enter) or unpublishing (x) does on a port row, or why it does nothing: only a port with no
 * preview publishes, and only a port's own preview unpublishes, since a service keeps its preview. A port already
 * changing is refused, as every other way to change it is.
 */
export function portAction(
	thread: string,
	row: PortRow,
	change: PortChange,
	canRun: boolean,
	want: "open" | "unpublish",
): { kind: "open" | "unpublish"; port: number } | { kind: "none"; why: string } {
	const port = row.kind === "port" ? row.port.port : row.port;
	// A preview with no port of its own has no change to wait for.
	if (port !== undefined && change.pending !== null) return { kind: "none", why: portBusy(thread, port) };
	if (row.kind === "port") {
		if (want === "unpublish") return { kind: "none", why: `Port ${row.port.port} has no preview to unpublish.` };
		if (row.port.service !== null) return { kind: "none", why: `Port ${row.port.port} belongs to the service ${row.port.service}, which has no preview to publish.` };
		return { kind: "open", port: row.port.port };
	}
	const own = linkedPort(row.preview.service);
	if (want === "open") return { kind: "none", why: `${row.preview.service} is published already.${own === undefined ? "" : " x unpublishes it."}` };
	if (own === undefined) return { kind: "none", why: `The service ${row.preview.service} keeps its preview. Only a port's own preview can be unpublished.` };
	if (!canRun) return { kind: "none", why: "The thread is not running, so its preview cannot be unpublished now." };
	return { kind: "unpublish", port: own };
}

export type PreviewLook = { linked: boolean; label: string | null; tone: Tone; hint: string | null };

/**
 * A paused pylon's preview keeps its link, because a visit wakes the pylon. An archived thread's pylon stays paused
 * whatever the visit, so its preview would only show the waking page. A failed preview, whose service failed or whose
 * port has no route into the pylon, has no link, because its URL cannot reach the server, and its hint is why.
 */
export function previewLook(detail: ThreadDetail, preview: Pick<Preview, "ready" | "failed">): PreviewLook {
	if (detail.thread.status === "archived") return { linked: false, label: "paused", tone: "idle", hint: "Unarchive the thread to open it." };
	if (detail.pylon.actualState === "paused") return { linked: true, label: "paused", tone: "idle", hint: "Opening it wakes the pylon." };
	if (preview.failed) return { linked: false, label: "failed", tone: "bad", hint: preview.failed };
	return preview.ready ? { linked: true, label: null, tone: "ok", hint: null } : { linked: false, label: "starting", tone: "busy", hint: null };
}

export interface StartForm {
	title: string;
	project: string;
	/** Empty for the project's default. */
	node: string;
	branch: string;
	message: string;
}

/** The start command's arguments. Empty optional fields mean the project's defaults, which the CLI leaves to the API. */
export function startArgs(form: StartForm): { project: string; title?: string; message?: string; node?: string; branch?: string } {
	const pick = (value: string) => value.trim() || undefined;
	const optional = { title: pick(form.title), message: form.message.trim() ? form.message : undefined, node: pick(form.node), branch: pick(form.branch) };
	return { project: form.project, ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined)) };
}

/** A project's repo URL, or `scratch` for a scratch project, as the dashboard and `nexus projects` list it. */
export const repoOf = (project: Project) => project.repoUrl ?? "scratch";

export function startHint(project: Project | undefined, form: StartForm): string {
	if (project === undefined) return "";
	const repo = project.repoUrl === null ? "starts an empty repository on" : "checks out";
	return `Boots a pylon on ${form.node.trim() || project.defaultNode} and ${repo} ${form.branch.trim() || project.defaultBranch}.`;
}
