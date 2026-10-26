/**
 * What the nexus CLI prints, as `docs/cli.md` in the nexus repo describes it, as TypeBox schemas. pi-nexus's types for
 * those shapes derive from these schemas, so no code reads a field they leave out, and `parse` checks each reply once,
 * where it leaves the CLI. Extra fields pass, since the contract says a consumer ignores the ones it does not know.
 * The schemas declare only the fields pi-nexus reads.
 */
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { NexusError } from "./thread.ts";

const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
/**
 * A union of objects that the `key` property tells apart, as pi-ai's messages are by `role` and their parts by
 * `type`. `parse` reports a failure inside one against the shape its key names.
 */
const Tagged = <T extends TSchema[]>(key: string, variants: [...T]) => Type.Union(variants, { discriminator: key });

/** What a checkout read compares with: the commit the pylon booted at, HEAD, or the snapshot before the latest agent reply. */
export const Base = Type.Object({ kind: Type.Union([Type.Literal("start"), Type.Literal("head"), Type.Literal("turn")]), commit: Nullable(Type.String()) });
export type Base = Static<typeof Base>;
export const ChangedFile = Type.Object({
	path: Type.String(), oldPath: Nullable(Type.String()),
	status: Type.Union([Type.Literal("added"), Type.Literal("modified"), Type.Literal("deleted"), Type.Literal("renamed"), Type.Literal("copied"), Type.Literal("typechange")]),
	additions: Nullable(Type.Number()), deletions: Nullable(Type.Number()),
});
export type ChangedFile = Static<typeof ChangedFile>;
export const Changes = Type.Object({ base: Base, files: Type.Array(ChangedFile), truncated: Type.Boolean() });
export type Changes = Static<typeof Changes>;
export const Diff = Type.Object({ base: Base, diff: Type.String(), truncated: Type.Boolean() });
export type Diff = Static<typeof Diff>;

const ThreadStatus = Type.Union([Type.Literal("active"), Type.Literal("idle"), Type.Literal("archived"), Type.Literal("deleted")]);
export type ThreadStatus = Static<typeof ThreadStatus>;

/** What the planner wants of a thread's pylon. */
const DesiredPhase = Type.Union([Type.Literal("running"), Type.Literal("paused"), Type.Literal("deleted")]);
export type DesiredPhase = Static<typeof DesiredPhase>;

const threadFields = {
	id: Type.String(),
	title: Type.String(),
	project: Type.String(),
	status: ThreadStatus,
	agentTurnRunning: Type.Boolean(),
	createdAt: Type.Number(),
	lastAgentActivityAt: Type.Number(),
	lastHumanActivityAt: Type.Number(),
	/** Null until the thread's agent has a conversation. */
	conversationId: Nullable(Type.String()),
};

/**
 * What the control plane says a thread wants of a person, shared by every client. `attention` stays a string, so a
 * value added later reads as nothing to show rather than failing the whole list.
 */
const seenFields = {
	seenAt: Nullable(Type.Number()),
	/** When the latest agent turn ended. */
	lastReplyAt: Nullable(Type.Number()),
	attention: Nullable(Type.String()),
};

/** The reply of `start`, `archive`, `unarchive` and `delete`, and `thread` in a detail. */
export const Thread = Type.Object(threadFields);
export type Thread = Static<typeof Thread>;

/** A row of `threads`: a thread with what the planner wants of its pylon and what its node last reported. */
export const ThreadRow = Type.Object({
	...threadFields,
	...seenFields,
	desired: DesiredPhase,
	pylon: Type.Object({ node: Type.String(), actualState: Type.String(), failed: Nullable(Type.String()) }),
});
export type ThreadRow = Static<typeof ThreadRow>;

/** A port published as a preview. Its `url` is the CLI's to build: use it as it is. */
export const Preview = Type.Object({
	/** The service it previews: a declared or ad hoc one, or `port-<port>` for a port previewed on its own. */
	service: Type.String(),
	/** The node publishes it and has warmed its URL, and `failed` is null. It says nothing else about the pylon answering. */
	ready: Type.Boolean(),
	/**
	 * Why it cannot answer: the pylon's node last reported its service failed, or its port without a route into the
	 * pylon. Null otherwise, and absent from a control plane older than the field, which means null too.
	 */
	failed: Type.Optional(Nullable(Type.String())),
	url: Type.String(),
});
export type Preview = Static<typeof Preview>;

/** The reply of `unpreview`, which has nothing to report. */
export const Unpreviewed = Type.Null();

/** A TCP port that something in the pylon listens on and a preview can reach. */
const ListeningPort = Type.Object({
	port: Type.Number(),
	/** The service that owns the port, or null for a process no service runs. */
	service: Nullable(Type.String()),
	/** That service's preview, or null while it has none. */
	preview: Nullable(Preview),
});
export type ListeningPort = Static<typeof ListeningPort>;

/** In port order. [] while the pylon is not running, and null while its node could not read them. */
export const Ports = Nullable(Type.Array(ListeningPort));

/** The agents `session open` can start in a pylon, its default first. */
export const harnesses = ["claude-code", "pi", "shell"] as const;

const sessionFields = {
	/** What `session close` takes: its pane, or `failed-<hash>` for a failed session in no pane. */
	id: Type.String(),
	harness: Type.String(),
	/** Herdr's status when the session last ran, `unknown` if it never did. */
	status: Type.String(),
	harnessSessionId: Nullable(Type.String()),
	/**
	 * Its Herdr workspace's label. Null when a probe older than CLI 0.5.0 last observed it, and absent from a control
	 * plane that old, which means null too.
	 */
	title: Type.Optional(Nullable(Type.String())),
};

/**
 * A session of the pylon, told apart by `state`: `running` in its pane, `paused` with its pylon until the next wake
 * brings it back, or `failed`, which the last wake did not bring back, with `message` saying why. A paused or failed
 * session's `herdrPane` is the pane it had or left behind, or null. Its harness is one of `harnesses`.
 */
const Session = Tagged("state", [
	Type.Object({ ...sessionFields, state: Type.Literal("running"), herdrPane: Type.String(), message: Type.Null() }),
	Type.Object({ ...sessionFields, state: Type.Literal("paused"), herdrPane: Nullable(Type.String()), message: Type.Null() }),
	Type.Object({ ...sessionFields, state: Type.Literal("failed"), herdrPane: Nullable(Type.String()), message: Type.String() }),
]);
export type Session = Static<typeof Session>;
export type SessionState = Session["state"];

/** The reply of `session open`: the session it opened, with the title the CLI gave it. */
export const OpenedSession = Type.Object({ herdrPane: Type.String(), harness: Type.String(), title: Type.String() });
export type OpenedSession = Static<typeof OpenedSession>;

/** The reply of `session close`, which has nothing to report. */
export const SessionClosed = Type.Null();

/** The reply of `show`. */
export const ThreadDetail = Type.Object({
	thread: Thread,
	...seenFields,
	/** Present for a thread whose worker is Claude Code, whose conversation `conversation` prints, never a watch. */
	claudeWorker: Type.Optional(Type.Object({ model: Nullable(Type.String()), state: Type.String(), message: Type.Optional(Type.String()) })),
	desired: DesiredPhase,
	pylon: Type.Object({
		id: Type.String(),
		node: Type.String(),
		actualState: Type.String(),
		failed: Nullable(Type.String()),
		observedAt: Nullable(Type.String()),
		/** Why a retry of the pylon cannot help, or null when it can. */
		retryRefused: Nullable(Type.String()),
	}),
	sessions: Type.Array(Session),
	/** Every preview of the thread, served or not, listening or not. */
	previews: Type.Array(Preview),
	ports: Ports,
	outputs: Type.Array(Type.Object({ kind: Type.String(), ref: Type.String() })),
	/** The command that attaches to the pylon's sessions from a shell in it. */
	attach: Type.String(),
	/** Null for a thread with no conversation. */
	agent: Nullable(Type.Object({ parkedTasks: Type.Number() })),
});
export type ThreadDetail = Static<typeof ThreadDetail>;

/**
 * `show`'s reply as `ThreadDetail`. A control plane older than CLI 0.8.0 lists only the sessions in panes, with no
 * `state`, `id` or `message`: each reads as running, named by its pane, as the control plane reads its older probes.
 */
export function parseDetail(value: unknown, what: string): ThreadDetail {
	const sessions = (value as { sessions?: unknown } | null)?.sessions;
	if (Array.isArray(sessions)) {
		for (const s of sessions) {
			if (typeof s === "object" && s !== null && !("state" in s)) Object.assign(s, { state: "running", id: (s as { herdrPane?: unknown }).herdrPane, message: null });
		}
	}
	return parse(ThreadDetail, value, what);
}

/** The reply of `send`: the submission a Nexus agent takes, or what Claude did with the message. */
export const Sent = Type.Union([
	Type.Object({ submission: Type.Number() }),
	Type.Object({ claude: Type.Object({ session: Type.String(), outcome: Type.String(), resumed: Type.Boolean() }) }),
]);
export type Sent = Static<typeof Sent>;

/** The reply of `seen`, which has nothing to report. */
export const Seen = Type.Null();

/** Each entry kind of a Claude worker's transcript that pi-nexus shows. */
export const claudeEntries = {
	/** `from` is `person`, `command` for a slash command, or another source, such as a plugin. */
	prompt: Type.Object({ kind: Type.Literal("prompt"), at: Type.Number(), text: Type.String(), from: Type.String() }),
	reply: Type.Object({ kind: Type.Literal("reply"), text: Type.String() }),
	tool: Type.Object({ kind: Type.Literal("tool"), id: Type.String(), name: Type.String(), input: Type.Record(Type.String(), Type.Unknown()) }),
	result: Type.Object({ kind: Type.Literal("result"), toolUseId: Type.String(), output: Type.String(), isError: Type.Boolean() }),
	/** A background subagent or shell finished. */
	task: Type.Object({ kind: Type.Literal("task"), status: Type.String(), summary: Type.String() }),
	/** A prompt typed while Claude was busy joins its queue on `enqueue`, and leaves it on any other op. */
	queue: Type.Object({ kind: Type.Literal("queue"), op: Type.String(), text: Nullable(Type.String()) }),
	/** `tone` is `info` or `error`. */
	notice: Type.Object({ kind: Type.Literal("notice"), tone: Type.String(), text: Type.String() }),
	turn: Type.Object({ kind: Type.Literal("turn"), durationMs: Type.Number() }),
	/** A transcript record the control plane does not know, kept visible. */
	record: Type.Object({ kind: Type.Literal("record"), type: Type.String(), summary: Type.String() }),
};
export type ClaudeEntry = { [K in keyof typeof claudeEntries]: Static<(typeof claudeEntries)[K]> }[keyof typeof claudeEntries];

const ClaudeConversation = Type.Object({
	kind: Type.Literal("claude"),
	entries: Type.Array(Type.Unknown()),
	/** How many older entries the control plane no longer keeps. */
	dropped: Type.Number(),
	/** When the transcript was last read from the pylon, or null if never. */
	readAt: Nullable(Type.Number()),
	/** Whether a turn of the worker's session runs. */
	working: Type.Boolean(),
});
export type ClaudeConversation = Omit<Static<typeof ClaudeConversation>, "entries"> & { entries: ClaudeEntry[] };

/**
 * `conversation`'s reply for a Claude worker thread. The contract asks a consumer to ignore the entry kinds it does
 * not know, so those are dropped, and each known one is checked against its shape.
 */
export function parseConversation(value: unknown, what: string): ClaudeConversation {
	const conversation = parse(ClaudeConversation, value, what);
	const entries = conversation.entries.flatMap((entry, i) => {
		const kind = (entry as { kind?: unknown } | null)?.kind;
		if (typeof kind !== "string" || !Object.hasOwn(claudeEntries, kind)) return [];
		return [parse(claudeEntries[kind as keyof typeof claudeEntries], entry, `${what}'s entry ${i}`) as ClaudeEntry];
	});
	return { ...conversation, entries };
}

/** A project as `projects` lists it and `project add` prints the one it added. */
export const Project = Type.Object({
	id: Type.String(),
	/** Null for a scratch project, whose threads start from an empty repository on the branch, with no remote. */
	repoUrl: Nullable(Type.String()),
	defaultNode: Type.String(),
	defaultBranch: Type.String(),
});
export type Project = Static<typeof Project>;

export const NodeSummary = Type.Object({ name: Type.String(), state: Type.Union([Type.Literal("online"), Type.Literal("offline")]) });
export type NodeSummary = Static<typeof NodeSummary>;

const TextPart = Type.Object({ type: Type.Literal("text"), text: Type.String() });
const ThinkingPart = Type.Object({ type: Type.Literal("thinking"), thinking: Type.String() });
const ImagePart = Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() });
const ToolCallPart = Type.Object({ type: Type.Literal("toolCall"), id: Type.String(), name: Type.String(), arguments: Type.Record(Type.String(), Type.Unknown()) });
export type ToolCallPart = Static<typeof ToolCallPart>;
export type Part = Static<typeof TextPart> | Static<typeof ThinkingPart> | Static<typeof ImagePart> | ToolCallPart;

/** The messages pi-ai has, each with the content and fields pi-ai gives its role. */
const SystemMessage = Type.Object({ role: Type.Literal("system"), content: Type.Union([Type.String(), Type.Array(TextPart)]) });
const UserMessage = Type.Object({
	role: Type.Literal("user"),
	content: Type.Union([Type.String(), Type.Array(Tagged("type", [TextPart, ImagePart]))]),
	timestamp: Type.Number(),
});
const AssistantMessage = Type.Object({
	role: Type.Literal("assistant"),
	content: Type.Array(Tagged("type", [TextPart, ThinkingPart, ToolCallPart])),
	model: Type.String(),
	/** pi-ai's stop reason. A string, so a reason added later reads as an answer that ended. */
	stopReason: Type.String(),
	errorMessage: Type.Optional(Type.String()),
});
export type AssistantMessage = Static<typeof AssistantMessage>;
const ToolResultMessage = Type.Object({
	role: Type.Literal("toolResult"),
	toolCallId: Type.String(),
	toolName: Type.String(),
	content: Type.Array(Tagged("type", [TextPart, ImagePart])),
	details: Type.Optional(Type.Unknown()),
	isError: Type.Boolean(),
});
export type ToolResultMessage = Static<typeof ToolResultMessage>;

/** A pi-ai message as the conversation route serves it. */
const Message = Tagged("role", [SystemMessage, UserMessage, AssistantMessage, ToolResultMessage]);
export type Message = Static<typeof Message>;

/** An entry of the conversation, with the CLI's plain rendering of its messages. An entry may hold no message. */
const renderedFields = { entry: Type.Object({ id: Type.Number(), model: Type.Optional(Type.Array(Message)) }), text: Type.String() };
const RenderedEntry = Type.Object(renderedFields);
export type RenderedEntry = Static<typeof RenderedEntry>;

const stateFields = {
	status: ThreadStatus,
	run: Type.Union([Type.Literal("idle"), Type.Literal("working"), Type.Literal("parked")]),
	parkedTasks: Type.Number(),
	queued: Type.Number(),
	/** The pylon's actual state. */
	pylon: Type.String(),
	failed: Nullable(Type.String()),
	ports: Ports,
};
const ThreadState = Type.Object(stateFields);
export type ThreadState = Static<typeof ThreadState>;

const liveFields = {
	/** The texts waiting to join the run. */
	queued: Type.Array(Type.String()),
	/** The output so far of running calls. A call whose result is in the entries is done, whatever this says. */
	tools: Type.Array(Type.Object({ callId: Type.String(), output: Type.String() })),
	/** The streaming answer's text. */
	partial: Nullable(Type.String()),
	/** The error of a model request waiting to be retried. */
	retry: Nullable(Type.String()),
};
/** What the agent's current run shows beyond its entries. */
const LiveRun = Type.Object(liveFields);
export type LiveRun = Static<typeof LiveRun>;

const event = <K extends string, F extends Record<string, TSchema>>(type: K, fields: F) =>
	Type.Object({ type: Type.Literal(type), thread: Type.String(), ...fields });

/** Each watch event type pi-nexus handles. The watch skips any other type, as the contract asks. */
export const watchEvents = {
	reset: event("reset", { entries: Type.Array(RenderedEntry) }),
	entry: event("entry", renderedFields),
	state: event("state", stateFields),
	live: event("live", liveFields),
	error: event("error", { kind: Type.Union([Type.Literal("unreachable"), Type.Literal("failed")]), message: Type.String() }),
};
export type WatchEvent = { [K in keyof typeof watchEvents]: Static<(typeof watchEvents)[K]> }[keyof typeof watchEvents];

/** `items/0/kind` as `items[0].kind`. */
const fieldName = (pointer: string) =>
	pointer
		.split("/")
		.slice(1)
		.map((step) => (/^\d+$/.test(step) ? `[${step}]` : `.${step}`))
		.join("")
		.replace(/^\./, "");

/**
 * Where the union that a failure inside one belongs to sits in the reply: one step per property or array item in
 * the schema path before its first union.
 */
function unionAt(schemaPath: string, instancePath: string): string {
	const steps = schemaPath.slice(0, schemaPath.indexOf("/anyOf/")).split("/").slice(1);
	let depth = 0;
	for (let i = 0; i < steps.length; i++) {
		if (steps[i] === "items") depth++;
		else if (steps[i] === "properties") {
			depth++;
			i++;
		}
	}
	return `/${instancePath.split("/").slice(1, depth + 1).join("/")}`;
}

/** What a JSON pointer, into a schema or a value, points at. */
const at = (root: unknown, pointer: string): unknown =>
	pointer
		.split("/")
		.slice(1)
		.reduce<unknown>((node, step) => (node as Record<string, unknown> | undefined)?.[step.replace(/~1/g, "/").replace(/~0/g, "~")], root);

/**
 * `value` as `schema` describes it, or a `contract` error that names the first field that breaks it. A failure
 * inside a tagged union is reported against the shape the value's tag names. One inside any other union is reported
 * as the union's, since which of its shapes was meant is a guess.
 */
export function parse<T extends TSchema>(schema: T, value: unknown, what: string): Static<T> {
	check(schema, value, what, "");
	return value as Static<T>;
}

/** Checks `value`, which sits at `base` in the reply, against `schema`. */
function check(schema: TSchema, value: unknown, what: string, base: string): void {
	if (Value.Check(schema, value)) return;
	const error = [...Value.Errors(schema, value)][0]!;
	const update = "Update the nexus CLI and the control plane";
	if (error.schemaPath.includes("/anyOf/") || error.keyword === "anyOf") {
		const union = error.keyword === "anyOf" ? error.instancePath : unionAt(error.schemaPath, error.instancePath);
		const unionSchema = at(schema, (error.keyword === "anyOf" ? error.schemaPath : error.schemaPath.slice(0, error.schemaPath.indexOf("/anyOf/"))).replace(/^#/, "")) as
			| { anyOf: { properties?: Record<string, { const?: unknown }> }[]; discriminator?: string }
			| undefined;
		const tagged = at(value, union);
		const key = unionSchema?.discriminator;
		if (key !== undefined && typeof tagged === "object" && tagged !== null) {
			const tag = (tagged as Record<string, unknown>)[key];
			const shape = unionSchema!.anyOf.find((s) => s.properties?.[key]?.const === tag);
			if (shape !== undefined) return check(shape as TSchema, tagged, what, base + union);
			const field = fieldName(`${base}${union}/${key}`);
			throw new NexusError("contract", `${what} breaks the contract: ${field} is none of the values the contract allows. ${update}`);
		}
		throw new NexusError("contract", `${what} breaks the contract: ${fieldName(base + union) || "the reply"} is none of the values or shapes the contract allows. ${update}`);
	}
	if (error.keyword === "required") {
		const field = fieldName(`${base}${error.instancePath}/${(error.params as { requiredProperties: string[] }).requiredProperties[0]}`);
		throw new NexusError("contract", `${what} has no ${field}, which pi-nexus needs. ${update}`);
	}
	throw new NexusError("contract", `${what} breaks the contract: ${fieldName(base + error.instancePath) || "the reply"} ${error.message}. ${update}`);
}
