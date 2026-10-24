import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createNexus, listThreads, readThread, sendText, startThread, threadId, unpreviewPort, type Nexus } from "./cli.ts";
import { actions, complete, parseCommand, usage, type NexusCommand } from "./commands.ts";
import { Console, userDisplay } from "./console/index.ts";
import type { Display } from "./console/transcript.ts";
import { follow, type FollowEnd } from "./follow.ts";
import { noteType, renderNote, type Note } from "./render.ts";
import { nexusTools } from "./tools.ts";
import type { Thread } from "./contract.ts";
import { emptyView, findThread, NexusError, stateLine, threadRows, transcript, workingCount, type ThreadView } from "./thread.ts";

const statusEveryMs = 30_000;

const ends: Readonly<Record<FollowEnd, string>> = {
	answered: "the agent answered",
	parked: "tasks are parked, /nexus retry runs them again",
	failed: "the pylon failed, /nexus retry-pylon boots it again",
	archived: "the thread is archived",
	deleted: "the thread was deleted",
	stopped: "stopped",
};

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * One pi session's Nexus state: the follows it runs and the status line. The status line starts with the first
 * /nexus command or Nexus tool call, so sessions that never touch Nexus never poll it. Every CLI process the session
 * starts ends with it, since pi replaces the extension runtime after a shutdown.
 */
class NexusSession {
	readonly closed = new AbortController();
	private ui: ExtensionUIContext | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly follows = new Map<string, { stop: AbortController; view: ThreadView }>();
	/** The threads last listed, for completion and titles. */
	threads: Thread[] = [];
	private readonly console: Console;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly nexus: Nexus,
		display: (cwd: string) => Display,
	) {
		this.console = new Console(nexus, this.closed.signal, display);
	}

	attach(ui: ExtensionUIContext): void {
		if (this.closed.signal.aborted) return;
		this.ui = ui;
		this.timer ??= setInterval(() => void this.refresh(), statusEveryMs).unref();
	}

	async refresh(): Promise<void> {
		if (this.closed.signal.aborted) return;
		try {
			this.threads = await listThreads(this.nexus, [], this.closed.signal);
			this.ui?.setStatus("nexus", `nexus ${workingCount(this.threads)} working`);
		} catch (err) {
			if (!this.closed.signal.aborted) this.ui?.setStatus("nexus", `nexus ${err instanceof NexusError ? err.kind : "failed"}`);
		}
	}

	private note(note: Note): void {
		this.pi.appendEntry(noteType, note);
	}

	private renderFollows(): void {
		const lines = [...this.follows].map(([id, { view }]) =>
			`following ${id}: ${view.outage ?? (view.state ? stateLine(view.state) : "connecting")}`,
		);
		this.ui?.setWidget("nexus", lines.length > 0 ? lines : undefined);
	}

	/** `nextTurn` as in follow(): an explicit follow waits for a turn, one after a send takes the reply to it. */
	startFollow(thread: string, nextTurn: boolean): void {
		if (this.follows.has(thread)) return;
		const entry = { stop: new AbortController(), view: emptyView };
		this.follows.set(thread, entry);
		this.renderFollows();
		const sink = {
			note: (note: Note) => this.note(note),
			state: (view: ThreadView) => {
				entry.view = view;
				this.renderFollows();
			},
		};
		follow(this.nexus, thread, sink, AbortSignal.any([entry.stop.signal, this.closed.signal]), nextTurn)
			.then((end) => this.ui?.notify(`Stopped following ${thread}: ${ends[end]}`, "info"))
			.catch((err) => this.ui?.notify(`nexus: following ${thread} failed: ${errorText(err)}`, "error"))
			.finally(() => {
				// A follow of the same thread started after this one was stopped owns the entry now.
				if (this.follows.get(thread) === entry) this.follows.delete(thread);
				this.renderFollows();
				void this.refresh();
			});
	}

	/** Stops a follow at once, so the same thread can be followed again before its watch has exited. */
	stopFollows(thread?: string): number {
		const stopping = thread === undefined ? [...this.follows.keys()] : this.follows.has(thread) ? [thread] : [];
		for (const id of stopping) {
			this.follows.get(id)!.stop.abort();
			this.follows.delete(id);
		}
		this.renderFollows();
		return stopping.length;
	}

	async run(command: NexusCommand, ctx: ExtensionCommandContext): Promise<void> {
		const nexus = this.nexus;
		const signal = this.closed.signal;
		const id = (ref: string) => threadId(nexus, ref, signal);
		switch (command.name) {
			case "help":
				return this.note({ title: "commands", body: usage });
			case "browse":
				// Without custom UI, as in RPC mode, the picker is the list it shows.
				if (await this.console.browse(ctx.ui, ctx.cwd)) return;
				return this.run({ name: "list" }, ctx);
			case "open": {
				const thread = await id(command.thread);
				if (await this.console.thread(ctx.ui, ctx.cwd, thread)) return;
				return this.run({ name: "show", thread }, ctx);
			}
			case "start": {
				const { name: _name, ...initial } = command;
				if (await this.console.start(ctx.ui, ctx.cwd, initial)) return;
				throw new NexusError("invalid", "the start form needs an interactive pi. /nexus new <project> <message> starts a thread without it");
			}
			case "list": {
				const threads = await listThreads(nexus, command.project ? [`--project=${command.project}`] : [], signal);
				return this.note({ title: command.project ? `threads of ${command.project}` : "threads", body: threadRows(threads) });
			}
			case "new": {
				const t = await startThread(nexus, command, signal);
				ctx.ui.notify(`Started ${t.id} on ${t.project}: ${t.title}`, "info");
				return this.startFollow(t.id, false);
			}
			case "send": {
				const thread = await id(command.thread);
				await sendText(nexus, thread, command.text, false, signal);
				ctx.ui.notify(`Sent to ${thread}.`, "info");
				return this.startFollow(thread, false);
			}
			case "show": {
				const thread = await id(command.thread);
				const view = await readThread(nexus, thread, signal);
				const title = this.threads.find((t) => t.id === thread)?.title;
				return this.note({
					title: `${thread}${title ? ` ${title}` : ""}: ${stateLine(view.state)}`,
					body: transcript(view.entries, 20_000),
				});
			}
			case "follow":
				return this.startFollow(await id(command.thread), true);
			case "unfollow": {
				// Matched against the follows themselves, so an unfollow works while Nexus is down.
				const thread = command.thread === undefined ? undefined : findThread(command.thread, [...this.follows.keys()]);
				const stopped = command.thread !== undefined && thread === undefined ? 0 : this.stopFollows(thread);
				if (stopped === 0) ctx.ui.notify("Not following that.", "info");
				return;
			}
			case "unpublish": {
				const thread = await id(command.thread);
				await unpreviewPort(nexus, thread, command.port, signal);
				return ctx.ui.notify(`Unpublished port ${command.port} of ${thread}. Publishing it again may give it a new URL.`, "info");
			}
			default: {
				const thread = await id(command.thread);
				if (command.name === "delete") {
					if (!ctx.hasUI) throw new NexusError("invalid", "delete asks for confirmation, which needs an interactive pi");
					// Keep comes first, so the highlighted answer and a dismissed dialog both keep the thread.
					const answer = await ctx.ui.select(`Delete ${thread}? Its pylon is deleted for good.`, ["Keep", "Delete"]);
					if (answer !== "Delete") return ctx.ui.notify(`Kept ${thread}.`, "info");
				}
				await nexus.run([command.name, thread], signal);
				ctx.ui.notify(`${actions[command.name].done} ${thread}.`, "info");
			}
		}
	}

	shutdown(): void {
		this.closed.abort();
		clearInterval(this.timer);
		this.ui?.setStatus("nexus", undefined);
		this.ui?.setWidget("nexus", undefined);
		this.ui = undefined;
	}
}

/** `display` reads pi's display settings, which a test replaces so it never reads the user's own. */
export default function nexusExtension(pi: ExtensionAPI, nexus: Nexus = createNexus(), display: (cwd: string) => Display = userDisplay) {
	const session = new NexusSession(pi, nexus, display);
	pi.registerEntryRenderer(noteType, renderNote);
	for (const tool of nexusTools(nexus)) {
		pi.registerTool({
			...tool,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				session.attach(ctx.ui);
				try {
					const owned = signal ? AbortSignal.any([signal, session.closed.signal]) : session.closed.signal;
					return await tool.execute(toolCallId, params, owned, onUpdate, ctx);
				} finally {
					void session.refresh();
				}
			},
		});
	}
	pi.registerCommand("nexus", {
		description: "Drive Nexus threads: list, new, send, show, follow, archive, delete and more",
		getArgumentCompletions: (prefix) => complete(prefix, session.threads),
		async handler(args, ctx) {
			session.attach(ctx.ui);
			try {
				await session.run(parseCommand(args), ctx);
			} catch (err) {
				if (!session.closed.signal.aborted) ctx.ui.notify(`nexus: ${errorText(err)}`, "error");
			}
			void session.refresh();
		},
	});
	pi.on("session_shutdown", () => session.shutdown());
}
