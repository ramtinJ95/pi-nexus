/**
 * The console: the web dashboard's views inside pi. The picker and the start form sit in the editor's place, as
 * pi's own selectors do. A thread fills the screen as an overlay. Each view gets everything through the nexus CLI.
 *
 * The person moves through the views as through a browser's history: opening a thread from the picker, or another
 * thread from a thread's picker, goes forward, and back returns to the thread or picker they came from.
 */
import { copyToClipboard, getMarkdownTheme, SettingsManager, type ExtensionUIContext, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { listNodes, listProjects, listThreads, previewPort, sendText, showThread, startThread, unpreviewPort, type Nexus } from "../cli.ts";
import type { Action } from "../commands.ts";
import { emptyView, lastActivityAt, NexusError, reduce, type ThreadView } from "../thread.ts";
import type { NodeSummary, ThreadRow } from "../contract.ts";
import type { Viewed } from "../store.ts";
import { isClosed, noteParked, startArgs, type Parked } from "./model.ts";
import { Picker, type PickerEnd } from "./picker.ts";
import { StartFormView } from "./start-form.ts";
import { ThreadScreen, type ScreenEnd } from "./thread-screen.ts";
import type { Display } from "./transcript.ts";

const pickerEveryMs = 5_000;
const detailEveryMs = 10_000;
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

/** Nodes, or why they cannot be read. The start form and the inspector work without them, saying so. */
const nodesOrError = (nexus: Nexus, signal: AbortSignal) =>
	listNodes(nexus, signal).catch((err: unknown): Error => (err instanceof Error ? err : new Error(String(err))));

/**
 * A view in the console's history. A picker opened from a thread is `switching`: what it opens takes its place, so
 * back from that thread returns to the one the picker was opened from. `at` is the thread a picker selects.
 */
type Place =
	| { kind: "picker"; switching: boolean; at?: string }
	| { kind: "thread"; id: string }
	| { kind: "start"; initial: { project?: string; title?: string } };

/** The thread whose agent is working, the most recently active first, which `/nexus` opens on. */
function workingThread(threads: readonly ThreadRow[]): string | undefined {
	return threads.filter((t) => t.agentTurnRunning && !isClosed(t)).sort((a, b) => lastActivityAt(b) - lastActivityAt(a))[0]?.id;
}

export class Console {
	/** Each thread's unsent message, kept while the person moves between views, however they leave the thread. */
	private readonly drafts = new Map<string, string>();

	constructor(
		private readonly nexus: Nexus,
		private readonly closed: AbortSignal,
		private readonly viewed: Viewed,
		/** The threads seen parked, which the open thread's watch keeps up to date. */
		private readonly parked: Parked,
		/** Says what went wrong outside a view, such as a look that could not be recorded. */
		private readonly warn: (message: string) => void,
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
	 * `/nexus`: the working thread with the picker under it, so back shows every thread, or the picker alone when no
	 * agent works. False when this pi cannot show them.
	 */
	async browse(ui: ExtensionUIContext, cwd: string): Promise<boolean> {
		// The picker reads the threads again and says why it could not.
		const threads = await listThreads(this.nexus, [], this.closed).catch(() => []);
		const working = workingThread(threads);
		const picker: Place = { kind: "picker", switching: false, ...(working ? { at: working } : {}) };
		return this.navigate(ui, cwd, working ? [picker, { kind: "thread", id: working }] : [picker]);
	}

	/** The start form, then the thread it started. False when this pi cannot show it. */
	start(ui: ExtensionUIContext, cwd: string, initial: { project?: string; title?: string }): Promise<boolean> {
		return this.navigate(ui, cwd, [{ kind: "start", initial }]);
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
			switch (place.kind) {
				case "picker": {
					const shown = await this.custom<PickerEnd>(ui, (tui, theme, _keybindings, done) => this.picker(tui, theme, done, place.at));
					if (shown === undefined) return false;
					const end = shown.result;
					if (end.kind === "open") {
						place.at = end.thread;
						forward({ kind: "thread", id: end.thread });
					} else if (end.kind === "new") forward({ kind: "start", initial: end.project === undefined ? {} : { project: end.project } });
					else if (end.kind === "back") back();
					else history.length = 0;
					break;
				}
				case "thread": {
					this.look(place.id);
					const shown = await this.custom<ScreenEnd>(ui, (tui, theme, keybindings, done) => this.screen(tui, theme, keybindings, done, cwd, place.id), {
						overlay: true,
						overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left" },
					});
					this.look(place.id);
					if (shown === undefined) return false;
					const end = shown.result;
					if (end.kind === "back") back();
					else if (end.kind === "close") history.length = 0;
					else if (end.kind === "threads") history.push({ kind: "picker", switching: true, at: place.id });
					else history.push({ kind: "start", initial: { project: end.project, title: end.title } });
					break;
				}
				case "start": {
					const [projects, nodes] = await Promise.all([listProjects(this.nexus, this.closed), nodesOrError(this.nexus, this.closed)]);
					const shown = await this.custom<string | null>(ui, (tui, theme, keybindings, done) =>
						new StartFormView({
							tui,
							theme,
							keybindings,
							projects,
							nodes,
							initial: place.initial,
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

	/** Records that the person looked at `thread` now, which clears its new marker. */
	private look(thread: string): void {
		try {
			this.viewed.mark(thread, Date.now());
		} catch (err) {
			this.warn(`pi-nexus could not record that you viewed ${thread}, so it may still show as new: ${message(err)}`);
		}
	}

	private picker(tui: TUI, theme: Theme, done: (end: PickerEnd) => void, at: string | undefined) {
		const stop = new AbortController();
		const signal = AbortSignal.any([stop.signal, this.closed]);
		const picker = new Picker(tui, theme, done, Date.now, at, () => void load());
		const begin = inOrder();
		const load = async () => {
			const current = begin();
			try {
				const [threads, projects] = await Promise.all([
					listThreads(this.nexus, ["--all"], signal),
					listProjects(this.nexus, signal).catch((err: unknown) => err as Error),
				]);
				if (signal.aborted || !current()) return;
				picker.setThreads(threads, Array.isArray(projects) ? projects : [], { seen: this.viewed.read(), parked: this.parked });
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

	private screen(tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (end: ScreenEnd) => void, cwd: string, thread: string) {
		const stop = new AbortController();
		const signal = AbortSignal.any([stop.signal, this.closed]);
		const nexus = this.nexus;
		const parked = this.parked;
		let view: ThreadView = emptyView;
		const begin = inOrder();
		const refreshDetail = async () => {
			const current = begin();
			const askedAt = screen.mark();
			try {
				const detail = await showThread(nexus, thread, signal);
				if (!signal.aborted && current()) screen.setDetail(detail, askedAt);
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
			draft: this.drafts.get(thread),
			done: (end) => {
				if (screen.draft === "") this.drafts.delete(thread);
				else this.drafts.set(thread, screen.draft);
				done(end);
			},
			actions: {
				async send(text, steer, requestId) {
					await sendText(nexus, thread, text, steer, signal, requestId);
				},
				async act(action: Action) {
					await nexus.run([action, thread], signal);
					void refreshDetail();
				},
				preview: (port) => previewPort(nexus, thread, port, signal),
				unpublish: (port) => unpreviewPort(nexus, thread, port, signal),
				refresh: () => void refreshDetail(),
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
						noteParked(parked, thread, view.state, Date.now());
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
				redraw.cancel();
				stop.abort();
				disposeScreen();
			},
		});
	}
}

