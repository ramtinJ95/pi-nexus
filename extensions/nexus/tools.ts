/**
 * The Nexus tools the model can call. Deleting a thread and retrying a pylon or parked tasks stay human-only, as
 * /nexus commands. Parameters, results and the wait rule match the Claude Code Nexus mod's tools exactly; only the
 * names carry a `nexus_` prefix, since pi does not namespace tools as Claude Code does (mcp__nexus__threads).
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema, type Static } from "typebox";
import { listThreads, previewPort, readThread, sendText, startThread, threadId, unpreviewPort, waitThread, type Nexus } from "./cli.ts";
import type { ListeningPort, ThreadState } from "./contract.ts";
import { ago, keepTail, lastActivityAt, latestReply, NexusError, transcript } from "./thread.ts";

const readChars = 6_000;
const replyChars = 4_000;

const threadParam = Type.String({ description: "Thread ID, or a unique prefix of one" });

/** A required string, trimmed, failing as the mod's tools do when it is blank. */
function required(value: string, name: string): string {
	if (!value.trim()) throw new NexusError("failed", `${name} is required`);
	return value.trim();
}

/** What only a human can do for a thread, so the model says so instead of waiting again. */
const needsHuman = (state: ThreadState | undefined) =>
	state?.run === "parked"
		? "Tasks hit the restart limit and are parked. A human must retry them with /nexus retry."
		: state?.pylon === "failed" || state?.failed
			? "The pylon failed. A human must retry it with /nexus retry-pylon."
			: undefined;

/** A listening port as the model reads it: its service and its preview's URL, when it has them. */
const portFacts = (port: ListeningPort) => ({
	port: port.port,
	...(port.service ? { service: port.service } : {}),
	...(port.preview ? { url: port.preview.url, ready: port.preview.ready } : {}),
});

const stateFields = (state: ThreadState | undefined) =>
	state && {
		status: state.status,
		run: state.run,
		pylon: state.pylon,
		queued: state.queued,
		...(state.failed ? { failed: state.failed } : {}),
		ports: state.ports && state.ports.map(portFacts),
	};

/**
 * A tool whose result is compact JSON. A failure throws, which pi reports to the model as a failed tool call, with
 * the text the mod gives it.
 */
function jsonTool<P extends TSchema>(spec: { name: string; label: string; description: string; parameters: P }, run: (params: Static<P>, signal: AbortSignal | undefined) => Promise<unknown>) {
	return defineTool({
		...spec,
		async execute(_id, params, signal) {
			try {
				const value = await run(params, signal);
				return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
			} catch (err) {
				if (err instanceof NexusError) throw new Error(`nexus (${err.kind}): ${err.message}`);
				throw err;
			}
		},
	});
}

export function nexusTools(nexus: Nexus) {
	return [
		jsonTool(
			{
				name: "nexus_threads",
				label: "Nexus threads",
				description:
					"List Nexus threads: coding agents, each in its own VM on the home lab, grouped by project. Gives id, project, title, status and whether the agent is working.",
				parameters: Type.Object({ project: Type.Optional(Type.String()) }, { additionalProperties: false }),
			},
			async ({ project }, signal) => {
				const now = Date.now();
				const threads = await listThreads(nexus, project?.trim() ? [`--project=${project.trim()}`] : [], signal);
				return threads.map((t) => ({
					id: t.id,
					project: t.project,
					title: t.title,
					status: t.status,
					working: t.agentTurnRunning,
					active: `${ago(now - lastActivityAt(t))} ago`,
				}));
			},
		),
		jsonTool(
			{
				name: "nexus_start",
				label: "Nexus start",
				description:
					"Start a Nexus thread on a project with a first message for its agent, and return its id. The agent works on its own; use nexus_wait for its reply.",
				parameters: Type.Object(
					{ project: Type.String(), message: Type.String(), title: Type.Optional(Type.String({ description: "Defaults to the first line of message" })) },
					{ additionalProperties: false },
				),
			},
			async ({ project, message, title }, signal) => {
				if (!project.trim() || !message.trim()) throw new Error("project and message are required");
				const t = await startThread(nexus, { project: project.trim(), message: message.trim(), ...(title?.trim() ? { title: title.trim() } : {}) }, signal);
				return { id: t.id, project: t.project, title: t.title };
			},
		),
		jsonTool(
			{
				name: "nexus_send",
				label: "Nexus send",
				description: "Send a message to a Nexus thread's agent. If it is working, the message waits for its current turn to end.",
				parameters: Type.Object({ thread: threadParam, text: Type.String() }, { additionalProperties: false }),
			},
			async (params, signal) => {
				const thread = await threadId(nexus, required(params.thread, "thread"), signal);
				await sendText(nexus, thread, required(params.text, "text"), false, signal);
				return { thread, sent: true };
			},
		),
		jsonTool(
			{
				name: "nexus_read",
				label: "Nexus read",
				description:
					"A Nexus thread's state (status, run, pylon, listening ports with any preview URL; ports null: unknown) and the latest part of its conversation.",
				parameters: Type.Object({ thread: threadParam }, { additionalProperties: false }),
			},
			async (params, signal) => {
				const thread = await threadId(nexus, required(params.thread, "thread"), signal);
				const view = await readThread(nexus, thread, signal);
				return { thread, ...stateFields(view.state), conversation: transcript(view.entries, readChars) };
			},
		),
		jsonTool(
			{
				name: "nexus_wait",
				label: "Nexus wait",
				description:
					"Wait until a Nexus thread's agent has answered and gone idle, or the timeout passes, then return its state and latest reply.",
				parameters: Type.Object(
					{ thread: threadParam, timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 600, description: "Default 300" })) },
					{ additionalProperties: false },
				),
			},
			async (params, signal) => {
				const thread = await threadId(nexus, required(params.thread, "thread"), signal);
				const seconds = params.timeout_seconds === undefined ? 300 : Math.min(600, Math.max(1, Math.round(params.timeout_seconds)));
				const { view, settled, timedOut, cancelled } = await waitThread(nexus, thread, seconds * 1000, signal);
				const reply = latestReply(view.entries);
				return {
					thread,
					settled,
					...(timedOut ? { timed_out: true } : {}),
					...(cancelled ? { cancelled: true } : {}),
					...stateFields(view.state),
					...(view.outage ? { outage: view.outage } : {}),
					...(needsHuman(view.state) ? { needs_human: needsHuman(view.state) } : {}),
					reply: reply ? keepTail(reply, replyChars) : null,
				};
			},
		),
		jsonTool(
			{
				name: "nexus_preview",
				label: "Nexus preview",
				description:
					"Publish a port the thread's pylon listens on as a preview, open to the home tailnet until unpublished, and return its URL once it is served (up to 2 min).",
				parameters: Type.Object({ thread: threadParam, port: Type.Integer({ minimum: 1, maximum: 65535 }) }, { additionalProperties: false }),
			},
			async (params, signal) => {
				const thread = await threadId(nexus, required(params.thread, "thread"), signal);
				if (signal?.aborted) throw new Error("nexus: cancelled before the port was published");
				try {
					const preview = await previewPort(nexus, thread, params.port, signal);
					return { thread, port: params.port, url: preview.url, ready: preview.ready };
				} catch (err) {
					if (signal?.aborted) throw new Error("nexus: cancelled while waiting for the preview; the port may be published already");
					throw err;
				}
			},
		),
		jsonTool(
			{
				name: "nexus_unpublish",
				label: "Nexus unpublish",
				description:
					"Close the preview a port of a Nexus thread was published as. A declared service's preview cannot be closed. Publishing the port again may give it a new URL. Wakes a paused pylon first (up to 2 min).",
				parameters: Type.Object({ thread: threadParam, port: Type.Integer({ minimum: 1, maximum: 65535 }) }, { additionalProperties: false }),
			},
			async (params, signal) => {
				const thread = await threadId(nexus, required(params.thread, "thread"), signal);
				if (signal?.aborted) throw new Error("nexus: cancelled before the preview was closed");
				try {
					await unpreviewPort(nexus, thread, params.port, signal);
					return { thread, port: params.port, unpublished: true };
				} catch (err) {
					if (signal?.aborted) throw new Error("nexus: cancelled while closing the preview; it may be closed already");
					throw err;
				}
			},
		),
		jsonTool(
			{
				name: "nexus_archive",
				label: "Nexus archive",
				description: "Archive a Nexus thread, which pauses its VM. The person can unarchive it.",
				parameters: Type.Object({ thread: threadParam }, { additionalProperties: false }),
			},
			async (params, signal) => {
				const thread = await threadId(nexus, required(params.thread, "thread"), signal);
				await nexus.run(["archive", thread], signal);
				return { thread, status: "archived" };
			},
		),
	];
}
