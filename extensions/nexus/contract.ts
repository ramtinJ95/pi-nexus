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

/** The reply of `start`, `archive`, `unarchive` and `delete`, and `thread` in a detail. */
export const Thread = Type.Object(threadFields);
export type Thread = Static<typeof Thread>;

/** A row of `threads`: a thread with what the planner wants of its pylon and what its node last reported. */
export const ThreadRow = Type.Object({
	...threadFields,
	desired: DesiredPhase,
	pylon: Type.Object({ node: Type.String(), actualState: Type.String(), failed: Nullable(Type.String()) }),
});
export type ThreadRow = Static<typeof ThreadRow>;

/** A port published as a preview. Its `url` is the CLI's to build: use it as it is. */
export const Preview = Type.Object({
	/** The service it previews: a declared or ad hoc one, or `port-<port>` for a port previewed on its own. */
	service: Type.String(),
	/** The node publishes it and has warmed its URL. It says nothing about the pylon answering. */
	ready: Type.Boolean(),
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

/** The reply of `show`. */
export const ThreadDetail = Type.Object({
	thread: Thread,
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
	sessions: Type.Array(Type.Object({ harness: Type.String(), herdrPane: Type.String(), status: Type.String(), harnessSessionId: Nullable(Type.String()) })),
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

export const Project = Type.Object({ id: Type.String(), repoUrl: Type.String(), defaultNode: Type.String(), defaultBranch: Type.String() });
export type Project = Static<typeof Project>;

export const NodeSummary = Type.Object({ name: Type.String(), state: Type.Union([Type.Literal("online"), Type.Literal("offline")]) });
export type NodeSummary = Static<typeof NodeSummary>;

/**
 * A union of objects that the `key` property tells apart, as pi-ai's messages are by `role` and their parts by
 * `type`. `parse` reports a failure inside one against the shape its key names.
 */
const Tagged = <T extends TSchema[]>(key: string, variants: [...T]) => Type.Union(variants, { discriminator: key });

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
