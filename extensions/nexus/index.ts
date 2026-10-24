import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createNexus, listThreads, readThread, sendText, startThread, threadId, unpreviewPort, type Nexus } from "./cli.ts";
import { actions, complete, parseCommand, usage, type NexusCommand } from "./commands.ts";
import { Console, userDisplay } from "./console/index.ts";
import { chips, noteParked, summary, type Parked } from "./console/model.ts";
import { Strip } from "./console/strip.ts";
import type { Display } from "./console/transcript.ts";
import { follow, type FollowEnd } from "./follow.ts";
import { noteType, renderNote, type Note } from "./render.ts";
import { nexusTools } from "./tools.ts";
import type { ThreadRow } from "./contract.ts";
import { emptyView, findThread, NexusError, stateLine, threadRows, transcript, type ThreadView } from "./thread.ts";
import { defaultSettingsFile, defaultViewedFile, settingsFile, viewedFile, type SettingsStore, type Viewed } from "./store.ts";

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
 * One pi session's Nexus state: the follows it runs, and the status line and strip, which poll the threads from the
 * session's start while the strip setting is on. `/nexus strip off` stops the polling, so a session that does not
 * want the summary never polls. Every CLI process the session starts ends with it, since pi replaces the extension
 * runtime after a shutdown.
 */
class NexusSession {
	readonly closed = new AbortController();
	private ui: ExtensionUIContext | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	/** The polling of the threads for the summary and strip, while the strip setting is on. */
	private polling: AbortController | undefined;
	private readonly follows = new Map<string, { stop: AbortController; view: ThreadView }>();
	/** The threads last listed, for completion and titles. */
	threads: ThreadRow[] = [];
	/** Whether the status line's summary and the strip show, and so whether the session polls the threads. */
	private strip: boolean;
	/** The threads seen parked, from the console's open thread and the follows. */
	private readonly parked: Parked = new Map();
	private readonly console: Console;
	private readonly viewed: Viewed;
	private readonly settings: SettingsStore;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly nexus: Nexus,
		display: (cwd: string) => Display,
		stores: Stores,
	) {
		({ viewed: this.viewed, settings: this.settings } = stores);
		this.strip = this.settings.read().strip;
		this.console = new Console(nexus, this.closed.signal, this.viewed, this.parked, (message) => this.ui?.notify(message, "warning"), display);
	}

	/** Takes the session's UI, and polls the threads while the strip setting is on. */
	attach(ui: ExtensionUIContext): void {
		if (this.closed.signal.aborted) return;
		this.ui = ui;
		if (!this.strip || this.polling !== undefined) return;
		this.polling = new AbortController();
		this.timer = setInterval(() => void this.refresh(), statusEveryMs).unref();
	}

	/** The session's start, where the summary and strip show at once rather than on the first poll. */
	start(ui: ExtensionUIContext): void {
		this.attach(ui);
		if (this.strip) void this.refresh();
	}

	/** Ends the polling, and the poll in flight with it, so no reply lands after the strip turned off. */
	private stopPolling(): void {
		this.polling?.abort();
		this.polling = undefined;
		clearInterval(this.timer);
		this.timer = undefined;
		this.ui?.setStatus("nexus", undefined);
		this.ui?.setWidget("nexus-strip", undefined);
	}

	/**
	 * Lists the threads for completion and the stored looks, and while the session polls, shows the summary and the
	 * strip. A poll ends when the polling stops; a list after a command with the strip off ends with the session.
	 */
	async refresh(): Promise<void> {
		if (this.closed.signal.aborted) return;
		const polling = this.polling;
		const signal = polling ? AbortSignal.any([polling.signal, this.closed.signal]) : this.closed.signal;
		try {
			const listedAt = Date.now();
			this.threads = await listThreads(this.nexus, [], signal);
			// The list leaves out only deleted threads, whose looks no marker reads again. A prune that cannot write
			// keeps them, which costs nothing, and the next look says the store cannot be written.
			try {
				this.viewed.prune(new Set(this.threads.map((t) => t.id)), listedAt);
			} catch {}
			if (polling === undefined || signal.aborted) return;
			const marks = { seen: this.viewed.read(), parked: this.parked };
			this.ui?.setStatus("nexus", summary(this.threads, marks));
			const shown = chips(this.threads, marks);
			const now = Date.now();
			this.ui?.setWidget("nexus-strip", shown.length > 0 ? (_tui, theme) => new Strip(theme, shown, now) : undefined);
		} catch (err) {
			if (polling !== undefined && !signal.aborted) this.ui?.setStatus("nexus", `nexus ${err instanceof NexusError ? err.kind : "failed"}`);
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
				noteParked(this.parked, thread, view.state, Date.now());
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
			case "strip":
				this.strip = command.on;
				try {
					this.settings.write({ ...this.settings.read(), strip: command.on });
				} catch (err) {
					ctx.ui.notify(`The strip is ${command.on ? "on" : "off"} for this session only, since its setting could not be saved: ${errorText(err)}`, "warning");
				}
				if (!command.on) return this.stopPolling();
				this.attach(ctx.ui);
				return this.refresh();
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
		this.polling?.abort();
		clearInterval(this.timer);
		this.ui?.setStatus("nexus", undefined);
		this.ui?.setWidget("nexus", undefined);
		this.ui?.setWidget("nexus-strip", undefined);
		this.ui = undefined;
	}
}

/** When each thread was last looked at, and the console's settings, kept in pi's agent directory. */
interface Stores {
	viewed: Viewed;
	settings: SettingsStore;
}

/** `display` reads pi's display settings, and a test replaces the stores so it never touches the user's own. */
export default function nexusExtension(
	pi: ExtensionAPI,
	nexus: Nexus = createNexus(),
	display: (cwd: string) => Display = userDisplay,
	stores: Stores = { viewed: viewedFile(defaultViewedFile()), settings: settingsFile(defaultSettingsFile()) },
) {
	const session = new NexusSession(pi, nexus, display, stores);
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
			let command: NexusCommand | undefined;
			try {
				command = parseCommand(args);
				await session.run(command, ctx);
			} catch (err) {
				if (!session.closed.signal.aborted) ctx.ui.notify(`nexus: ${errorText(err)}`, "error");
			}
			// strip on refreshes itself, and strip off must not list again.
			if (command?.name !== "strip") void session.refresh();
		},
	});
	// Print and JSON modes have no status line or widgets to fill.
	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI) session.start(ctx.ui);
	});
	pi.on("session_shutdown", () => session.shutdown());
}
