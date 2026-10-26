/**
 * The console: the web dashboard's views inside pi. The picker and the start form sit in the editor's place, as
 * pi's own selectors do. A thread fills the screen as an overlay. Each view gets everything through the nexus CLI.
 *
 * The person moves through the views as through a browser's history: opening a thread from the picker, or another
 * thread from a thread's picker, goes forward, and back returns to the thread or picker they came from. The project
 * picker scopes the thread picker to one project, or every project, and its scope outlives the console.
 */
import { copyToClipboard, getMarkdownTheme, SettingsManager, type ExtensionUIContext, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
	addProject,
	attachThread,
	closeSession,
	listNodes,
	listProjects,
	listThreads,
	markSeen,
	openSession,
	previewPort,
	readChanges,
	readConversation,
	readDiff,
	sendText,
	showThread,
	startThread,
	unpreviewPort,
	type Nexus,
} from "../cli.ts";
import type { Action } from "../commands.ts";
import { emptyView, isWorking, lastActivityAt, NexusError, reduce, type ThreadView } from "../thread.ts";
import type { NodeSummary, ThreadDetail, ThreadRow } from "../contract.ts";
import { inScope, type Scope } from "../scope.ts";
import type { SettingsStore } from "../store.ts";
import { attachCommand, isClosed, startArgs, unread } from "./model.ts";
import { Picker, type PickerEnd } from "./picker.ts";
import { ProjectFormView } from "./project-form.ts";
import { ProjectPicker, type ProjectEnd } from "./project-picker.ts";
import { StartFormView } from "./start-form.ts";
import { ThreadScreen, type Draft, type ScreenEnd } from "./thread-screen.ts";
import type { Display } from "./transcript.ts";

const pickerEveryMs = 5_000;
const detailEveryMs = 10_000;
/** How often a Claude worker's transcript is read while its turn runs, as the dashboard reads it. */
const claudeEveryMs = 2_000;
/** The longest a failed read of the transcript waits before it is tried again. */
const claudeRetryMaxMs = 60_000;
/** The most often a thread redraws: a streaming answer prints a live event up to ten times a second. */
const drawEveryMs = 100;

type Factory<T> = (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: T) => void) => Component & { dispose?(): void };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Runs `draw` at most every `ms`. The first change after a quiet spell draws after a zero wait, so the lines the CLI
 * printed together, such as a poll's reset and state, draw as one. Later changes draw the latest once `ms` has passed.
 */
function coalesced(ms: number, draw: () => void): { request(): void; cancel(): void } {
	let soon: ReturnType<typeof setTimeout> | undefined;
	let cooling: ReturnType<typeof setTimeout> | undefined;
	let dirty = false;
	const run = () => {
		soon = undefined;
		dirty = false;
		draw();
		cooling = setTimeout(() => {
			cooling = undefined;
			if (dirty) run();
		}, ms);
	};
	return {
		request() {
			dirty = true;
			if (soon === undefined && cooling === undefined) soon = setTimeout(run, 0);
		},
		cancel() {
			clearTimeout(soon);
			clearTimeout(cooling);
		},
	};
}

/**
 * Replies applied in the order their requests went out. `begin()` marks a request and returns its check, which is
 * false once a later request's reply has landed, so an older reply arriving late cannot undo a newer one.
 */
function inOrder(): () => () => boolean {
	let begun = 0;
	let landed = 0;
	return () => {
		const id = ++begun;
		return () => {
			if (id < landed) return false;
			landed = id;
			return true;
		};
	};
}

/** The user's own pi display settings, so a thread draws as their sessions do. */
export function userDisplay(cwd: string): Display {
	const settings = SettingsManager.create(cwd);
	return {
		outputPad: settings.getOutputPad(),
		hideThinkingBlock: settings.getHideThinkingBlock(),
		editorPaddingX: settings.getEditorPaddingX(),
		markdownTheme: { ...getMarkdownTheme(), codeBlockIndent: settings.getCodeBlockIndent() },
	};
}

/**
 * Gives the terminal to `nexus attach` until the person detaches, as pi gives it to an external editor: the TUI
 * stops, which hands back the keyboard and the screen, and starts again after, drawing everything afresh. Ctrl+C in
 * the meantime, such as while the CLI waits for a paused pylon, reaches the CLI, which stops, and not pi, which
 * ignores it as it does while suspended.
 */
async function attached(nexus: Nexus, tui: TUI, thread: string): Promise<void> {
	const ignore = () => {};
	process.on("SIGINT", ignore);
	tui.stop();
	try {
		tui.terminal.write(`Attaching to the sessions of ${thread} with ${attachCommand(nexus.bin, thread)}. Detach from Herdr to come back to pi.\n`);
		await attachThread(nexus, thread);
	} finally {
		process.off("SIGINT", ignore);
		tui.start();
		tui.requestRender(true);
	}
}

/** Nodes, or why they cannot be read. The start form and the inspector work without them, saying so. */
const nodesOrError = (nexus: Nexus, signal: AbortSignal) =>
	listNodes(nexus, signal).catch((err: unknown): Error => (err instanceof Error ? err : new Error(String(err))));

/**
 * A view in the console's history. A picker opened from a thread is `switching`: what it opens takes its place, so
 * back from that thread returns to the one the picker was opened from. `at` is the thread a picker selects. The
 * project picker, and the form that adds a project, leave the history once a project is chosen.
 */
type Place =
	| { kind: "picker"; switching: boolean; at?: string }
	| { kind: "thread"; id: string }
	| { kind: "start"; initial: { project?: string; title?: string } }
	| { kind: "projects" }
	| { kind: "new-project" };

/** The thread whose agent is working, the most recently active first, which `/nexus` opens on. */
function workingThread(threads: readonly ThreadRow[]): string | undefined {
	return threads.filter((t) => isWorking(t) && !isClosed(t)).sort((a, b) => lastActivityAt(b) - lastActivityAt(a))[0]?.id;
}

export class Console {
	/** Each thread's unsent message, kept while the person moves between views, however they leave the thread. */
	private readonly drafts = new Map<string, Draft>();

	constructor(
		private readonly nexus: Nexus,
		private readonly closed: AbortSignal,
		/** The project whose threads the picker shows, which the project picker changes. */
		private readonly scope: Scope,
		/** Says what went wrong outside a view, such as a reply that could not be marked seen. */
		private readonly warn: (message: string) => void,
		private readonly settings: SettingsStore,
		private readonly display: (cwd: string) => Display = userDisplay,
	) {}

	/**
	 * Runs `factory` in `ui.custom` and returns its result, or undefined when this pi has no custom UI, as in RPC
	 * mode, where custom() resolves without calling the factory.
	 */
	private async custom<T>(
		ui: ExtensionUIContext,
		factory: Factory<T>,
		options?: Parameters<ExtensionUIContext["custom"]>[1],
	): Promise<{ result: T } | undefined> {
		let shown = false;
		const result = (await ui.custom<T>((...args) => {
			shown = true;
			return this.disposedOnClose(factory(...args));
		}, options)) as T;
		return shown ? { result } : undefined;
	}

	/**
	 * Disposes `component` when the session ends as well as when pi disposes it, once either way. pi can hide an
	 * overlay without disposing it, and the view's timers would outlive the session.
	 */
	private disposedOnClose<C extends Component & { dispose?(): void }>(component: C): C {
		const dispose = component.dispose?.bind(component);
		if (dispose === undefined) return component;
		let disposed = false;
		const once = () => {
			if (disposed) return;
			disposed = true;
			this.closed.removeEventListener("abort", once);
			dispose();
		};
		if (this.closed.aborted) once();
		else this.closed.addEventListener("abort", once, { once: true });
		component.dispose = once;
		return component;
	}

	/**
	 * `/nexus`: the working thread of the project shown with the picker under it, so back shows the project's threads,
	 * or the picker alone when no agent works there. False when this pi cannot show them.
	 */
	async browse(ui: ExtensionUIContext, cwd: string): Promise<boolean> {
		// The picker reads the threads again and says why it could not.
		const threads = await listThreads(this.nexus, [], this.closed).catch(() => []);
		const working = workingThread(inScope(threads, this.scope.project));
		const picker: Place = { kind: "picker", switching: false, ...(working ? { at: working } : {}) };
		return this.navigate(ui, cwd, working ? [picker, { kind: "thread", id: working }] : [picker]);
	}

	/** The start form, then the thread it started. False when this pi cannot show it. */
	start(ui: ExtensionUIContext, cwd: string, initial: { project?: string; title?: string }): Promise<boolean> {
		return this.navigate(ui, cwd, [{ kind: "start", initial }]);
	}

	/**
	 * Attaches this terminal to the thread's pylon until the person detaches. False when this pi has no terminal to
	 * give, as in RPC mode.
	 */
	async attach(ui: ExtensionUIContext, thread: string): Promise<boolean> {
		const shown = await this.custom<Error | null>(ui, (tui, _theme, _keybindings, done) => {
			attached(this.nexus, tui, thread).then(
				() => done(null),
				(err: unknown) => done(err instanceof Error ? err : new Error(String(err))),
			);
			// Nothing to draw: the terminal is the attach's until it ends, and then this is gone.
			return { render: () => [], invalidate() {} };
		});
		if (shown === undefined) return false;
		if (shown.result !== null) throw shown.result;
		return true;
	}

	/** The thread view. False when this pi cannot show it. */
	thread(ui: ExtensionUIContext, cwd: string, thread: string): Promise<boolean> {
		return this.navigate(ui, cwd, [{ kind: "thread", id: thread }]);
	}

	/** Shows the last of `history` and goes where the person goes from it, until they leave. */
	private async navigate(ui: ExtensionUIContext, cwd: string, history: Place[]): Promise<boolean> {
		while (history.length > 0 && !this.closed.aborted) {
			const place = history.at(-1)!;
			const back = () => history.pop();
			const forward = (next: Place) => {
				if (place.kind === "picker" && place.switching) history.pop();
				history.push(next);
			};
			/**
			 * Leaves the project picker, and the form above it, once a project is chosen, for that project's threads: the
			 * picker they came from, or from a thread a picker that switches from it, as t opens.
			 */
			const chosen = (project: string | null) => {
				this.scope.set(project);
				while (history.at(-1)?.kind === "projects" || history.at(-1)?.kind === "new-project") history.pop();
				const from = history.at(-1);
				if (from?.kind === "thread") history.push({ kind: "picker", switching: true, at: from.id });
				else if (from?.kind !== "picker") history.push({ kind: "picker", switching: false });
			};
			switch (place.kind) {
				case "picker": {
					const shown = await this.custom<PickerEnd>(ui, (tui, theme, _keybindings, done) => this.picker(tui, theme, done, place.at));
					if (shown === undefined) return false;
					const end = shown.result;
					if (end.kind === "open") {
						place.at = end.thread;
						forward({ kind: "thread", id: end.thread });
					} else if (end.kind === "new") forward({ kind: "start", initial: end.project === undefined ? {} : { project: end.project } });
					else if (end.kind === "projects") history.push({ kind: "projects" });
					else if (end.kind === "back") back();
					else history.length = 0;
					break;
				}
				case "thread": {
					const shown = await this.custom<ScreenEnd>(ui, (tui, theme, keybindings, done) => this.screen(tui, theme, keybindings, done, cwd, place.id), {
						overlay: true,
						overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left" },
					});
					if (shown === undefined) return false;
					const end = shown.result;
					if (end.kind === "back") back();
					else if (end.kind === "close") history.length = 0;
					else if (end.kind === "threads") history.push({ kind: "picker", switching: true, at: place.id });
					else if (end.kind === "projects") history.push({ kind: "projects" });
					else history.push({ kind: "start", initial: { project: end.project, title: end.title } });
					break;
				}
				case "projects": {
					const shown = await this.custom<ProjectEnd>(ui, (tui, theme, _keybindings, done) => this.projectPicker(tui, theme, done));
					if (shown === undefined) return false;
					const end = shown.result;
					if (end.kind === "cancel") back();
					else if (end.kind === "new") history.push({ kind: "new-project" });
					else chosen(end.project);
					break;
				}
				case "new-project": {
					const nodes = await nodesOrError(this.nexus, this.closed);
					const shown = await this.custom<string | null>(ui, (tui, theme, _keybindings, done) =>
						new ProjectFormView({
							tui,
							theme,
							nodes,
							add: async (form) => done((await addProject(this.nexus, form, this.closed)).id),
							cancel: () => done(null),
						}),
					);
					if (shown === undefined) return false;
					// Cancelling goes back to the project picker.
					if (shown.result === null) back();
					else chosen(shown.result);
					break;
				}
				case "start": {
					const asked = this.scope.project;
					const [projects, nodes] = await Promise.all([listProjects(this.nexus, this.closed), nodesOrError(this.nexus, this.closed)]);
					this.scope.check(projects, asked);
					const shown = await this.custom<string | null>(ui, (tui, theme, keybindings, done) =>
						new StartFormView({
							tui,
							theme,
							keybindings,
							projects,
							nodes,
							// A form opened with no project starts on the project shown.
							initial: { ...place.initial, project: place.initial.project ?? this.scope.project ?? undefined },
							start: async (form) => done((await startThread(this.nexus, startArgs(form), this.closed)).id),
							cancel: () => done(null),
						}),
					);
					if (shown === undefined) return false;
					back();
					if (shown.result !== null) history.push({ kind: "thread", id: shown.result });
					break;
				}
			}
		}
		return true;
	}

	private picker(tui: TUI, theme: Theme, done: (end: PickerEnd) => void, at: string | undefined) {
		const stop = new AbortController();
		const signal = AbortSignal.any([stop.signal, this.closed]);
		const picker = new Picker(tui, theme, done, Date.now, at, () => void load());
		const begin = inOrder();
		const load = async () => {
			const current = begin();
			const asked = this.scope.project;
			try {
				const [threads, projects] = await Promise.all([
					listThreads(this.nexus, ["--all"], signal),
					listProjects(this.nexus, signal).catch((err: unknown) => err as Error),
				]);
				if (signal.aborted || !current()) return;
				if (Array.isArray(projects)) this.scope.check(projects, asked);
				picker.setThreads(threads, Array.isArray(projects) ? projects : [], this.scope.project);
				if (!Array.isArray(projects)) picker.setError(`The projects could not be read, so only projects with threads show: ${message(projects)}`);
			} catch (err) {
				if (!signal.aborted && current()) picker.setError(`The threads could not be read: ${message(err)}`);
			}
		};
		void load();
		const timer = setInterval(() => void load(), pickerEveryMs);
		return Object.assign(picker, {
			dispose() {
				clearInterval(timer);
				stop.abort();
			},
		});
	}

	private projectPicker(tui: TUI, theme: Theme, done: (end: ProjectEnd) => void) {
		const stop = new AbortController();
		const asked = this.scope.project;
		const picker = new ProjectPicker(tui, theme, done, asked);
		listProjects(this.nexus, AbortSignal.any([stop.signal, this.closed])).then(
			(projects) => {
				if (stop.signal.aborted) return;
				this.scope.check(projects, asked);
				picker.setProjects(projects);
			},
			(err: unknown) => stop.signal.aborted || picker.setError(`The projects could not be read: ${message(err)}`),
		);
		return Object.assign(picker, { dispose: () => stop.abort() });
	}

	private screen(tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (end: ScreenEnd) => void, cwd: string, thread: string) {
		const stop = new AbortController();
		const signal = AbortSignal.any([stop.signal, this.closed]);
		const nexus = this.nexus;
		let view: ThreadView = emptyView;
		const begin = inOrder();
		/** The details last read, whose reply a transcript read about to start covers. */
		let latest: ThreadDetail | undefined;
		/** The latest reply a mark went out for, and whether a mark failed for a reason trying again cannot fix. */
		let marked: number | null = null;
		let marking = false;
		let markFailed = false;
		/** When a mark that failed in an outage may be tried again, since every draw of the shown reply asks for one. */
		let markAfter = 0;
		/**
		 * Marks `reply` seen, for every client, once the view has shown it. The details are read again first, and a newer
		 * reply than the one shown skips the mark, which that reply's own showing makes. The session's signal, not the
		 * view's, ends it, so leaving the thread does not abort a mark under way.
		 */
		const markRead = async (reply: number) => {
			if (markFailed || marking || Date.now() < markAfter || (marked !== null && reply <= marked)) return;
			marking = true;
			marked = reply;
			try {
				const now = await showThread(nexus, thread, this.closed);
				if (now.lastReplyAt === reply && unread(now)) await markSeen(nexus, thread, this.closed);
			} catch (err) {
				if (this.closed.aborted) return;
				// A failure an outage explains marks the reply on a later showing.
				if (!(err instanceof NexusError && err.kind === "invalid")) {
					marked = null;
					markAfter = Date.now() + detailEveryMs;
				} else if (!markFailed) {
					markFailed = true;
					this.warn(`pi-nexus could not mark ${thread}'s reply seen, so it still shows as new in every client: ${message(err)}`);
				}
			} finally {
				marking = false;
			}
		};
		/**
		 * A Claude worker's transcript, which the watch never streams, read one read at a time: at once, every
		 * `claudeEveryMs` while its turn runs, and otherwise only when the details, a send or r say something changed, since
		 * each read makes the control plane read the pylon. A failed read is tried again, waiting twice as long each time up
		 * to `claudeRetryMaxMs`, and says so once; a CLI too old to read it stops the reading until r. Nothing is read
		 * while this terminal is attached to the pylon.
		 */
		let claudeRead: { again: boolean } | undefined;
		let claudeTimer: ReturnType<typeof setTimeout> | undefined;
		let claudeFailures = 0;
		let claudeStopped = false;
		let attaching = false;
		let claudeSeen: string | undefined;
		const readClaude = async (): Promise<void> => {
			if (claudeStopped || attaching || signal.aborted || latest?.claudeWorker === undefined) return;
			if (claudeRead !== undefined) return void (claudeRead.again = true);
			const read = (claudeRead = { again: false });
			clearTimeout(claudeTimer);
			// The reply the details knew before the read, which the transcript read after it holds.
			const replyAt = latest.lastReplyAt;
			try {
				const conversation = await readConversation(nexus, thread, signal);
				if (signal.aborted) return;
				claudeFailures = 0;
				screen.setConversation(conversation, replyAt);
				if (conversation.working) claudeTimer = setTimeout(() => void readClaude(), claudeEveryMs);
			} catch (err) {
				if (signal.aborted) return;
				if (claudeFailures === 0) screen.say(`Claude's transcript could not be read: ${message(err)}`, true);
				if (err instanceof NexusError && err.kind === "invalid") claudeStopped = true;
				else claudeTimer = setTimeout(() => void readClaude(), Math.min(claudeEveryMs * 2 ** claudeFailures, claudeRetryMaxMs));
				claudeFailures++;
			} finally {
				claudeRead = undefined;
				if (read.again) void readClaude();
			}
		};
		/** Reads the transcript again when the details show a turn ended, its attention or the pylon changed. */
		const claudeChanged = (detail: ThreadDetail) => {
			if (detail.claudeWorker === undefined) return;
			const seen = JSON.stringify([detail.lastReplyAt, detail.attention, detail.thread.lastAgentActivityAt, detail.thread.status, detail.pylon.actualState]);
			if (seen === claudeSeen) return;
			claudeSeen = seen;
			void readClaude();
		};
		const refreshDetail = async () => {
			const current = begin();
			const askedAt = screen.mark();
			try {
				const detail = await showThread(nexus, thread, signal);
				if (!signal.aborted && current()) {
					latest = detail;
					screen.setDetail(detail, askedAt);
					claudeChanged(detail);
				}
			} catch (err) {
				// The watch reports an outage itself.
				if (!signal.aborted && current() && !(err instanceof NexusError && (err.kind === "unreachable" || err.kind === "failed"))) {
					screen.say(`The thread's details could not be read: ${message(err)}`, true);
				}
			}
		};
		const screen = new ThreadScreen({
			tui,
			theme,
			keybindings,
			display: this.display(cwd),
			thread,
			cli: nexus.bin,
			checkout: {
				base: this.settings.read().base ?? "start",
				actions: {
					changes: (base, aborted) => readChanges(nexus, thread, base, AbortSignal.any([signal, aborted])),
					diff: (paths, base, aborted) => readDiff(nexus, thread, paths, base, AbortSignal.any([signal, aborted])),
					persist: (base) => this.settings.update({ base }),
				},
			},
			draft: this.drafts.get(thread),
			done: (end) => {
				const draft = screen.draft;
				if (draft.text === "" && draft.failed === undefined) this.drafts.delete(thread);
				else this.drafts.set(thread, draft);
				done(end);
			},
			actions: {
				async send(text, steer, requestId) {
					const sent = await sendText(nexus, thread, text, steer, signal, requestId);
					if ("claude" in sent) void readClaude();
					return sent;
				},
				async act(action: Action) {
					await nexus.run([action, thread], signal);
					void refreshDetail();
				},
				preview: (port) => previewPort(nexus, thread, port, signal),
				unpublish: (port) => unpreviewPort(nexus, thread, port, signal),
				openSession: (harness, title) => openSession(nexus, thread, { harness, ...(title === undefined ? {} : { title }) }, signal),
				closeSession: (id) => closeSession(nexus, thread, id, signal),
				async attach() {
					attaching = true;
					clearTimeout(claudeTimer);
					try {
						await attached(nexus, tui, thread);
					} finally {
						attaching = false;
						void readClaude();
					}
				},
				refresh() {
					void refreshDetail();
					claudeStopped = false;
					claudeFailures = 0;
					void readClaude();
				},
				shown: (reply) => void markRead(reply),
				rewatch: () => watch(),
				copy: (text) => copyToClipboard(text),
			},
		});
		const redraw = coalesced(drawEveryMs, () => screen.setView(view));
		let lastState: string | undefined;
		function watch() {
			nexus
				.watch(
					thread,
					(event) => {
						view = reduce(view, event);
						redraw.request();
						if (event.type !== "state") return;
						// A changed state can change what only the detail holds, such as the pylon's node, its previews or a
						// retry refusal.
						const key = JSON.stringify(view.state);
						if (key !== lastState) void refreshDetail();
						lastState = key;
					},
					signal,
				)
				.then(
					() => signal.aborted || screen.watchEnded(undefined),
					(err: unknown) => signal.aborted || screen.watchEnded(message(err)),
				);
		}
		watch();
		// Opening a thread counts as a visit, as on the dashboard, which wakes a paused pylon.
		nexus.run(["wake", thread], signal).catch((err: unknown) => {
			if (!signal.aborted) screen.say(`This visit was not recorded, so a paused pylon stays paused: ${message(err)}`, true);
		});
		void nodesOrError(nexus, signal).then((nodes: readonly NodeSummary[] | Error) => signal.aborted || screen.setNodes(nodes));
		const timer = setInterval(() => void refreshDetail(), detailEveryMs);
		const disposeScreen = screen.dispose.bind(screen);
		return Object.assign(screen, {
			dispose() {
				clearInterval(timer);
				clearTimeout(claudeTimer);
				redraw.cancel();
				stop.abort();
				disposeScreen();
			},
		});
	}
}

