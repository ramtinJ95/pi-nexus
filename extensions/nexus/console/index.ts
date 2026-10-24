/**
 * The console: the web dashboard's views inside pi. The picker and the start form sit in the editor's place, as
 * pi's own selectors do. A thread fills the screen as an overlay. Each view gets everything through the nexus CLI.
 */
import { copyToClipboard, getMarkdownTheme, SettingsManager, type ExtensionUIContext, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { listNodes, listProjects, listThreads, previewPort, sendText, showThread, startThread, unpreviewPort, type Nexus } from "../cli.ts";
import type { Action } from "../commands.ts";
import { emptyView, NexusError, reduce, type ThreadView } from "../thread.ts";
import type { NodeSummary } from "../contract.ts";
import { startArgs } from "./model.ts";
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

export class Console {
	constructor(
		private readonly nexus: Nexus,
		private readonly closed: AbortSignal,
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

	/** The picker, then what it chose. False when this pi cannot show it. */
	async browse(ui: ExtensionUIContext, cwd: string): Promise<boolean> {
		const shown = await this.custom<PickerEnd>(ui, (tui, theme, _keybindings, done) => {
			const stop = new AbortController();
			const signal = AbortSignal.any([stop.signal, this.closed]);
			const picker = new Picker(tui, theme, done);
			const begin = inOrder();
			const load = async () => {
				const current = begin();
				try {
					const [threads, projects] = await Promise.all([
						listThreads(this.nexus, ["--all"], signal),
						listProjects(this.nexus, signal).catch((err: unknown) => err as Error),
					]);
					if (signal.aborted || !current()) return;
					picker.setThreads(threads, Array.isArray(projects) ? projects : []);
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
		});
		if (shown === undefined) return false;
		const end = shown.result;
		if (end.kind === "open") await this.thread(ui, cwd, end.thread);
		if (end.kind === "new") await this.start(ui, cwd, end.project === undefined ? {} : { project: end.project });
		return true;
	}

	/** The start form, then the thread it started. False when this pi cannot show it. */
	async start(ui: ExtensionUIContext, cwd: string, initial: { project?: string; title?: string }): Promise<boolean> {
		const [projects, nodes] = await Promise.all([listProjects(this.nexus, this.closed), nodesOrError(this.nexus, this.closed)]);
		const shown = await this.custom<string | null>(ui, (tui, theme, keybindings, done) =>
			new StartFormView({
				tui,
				theme,
				keybindings,
				projects,
				nodes,
				initial,
				start: async (form) => done((await startThread(this.nexus, startArgs(form), this.closed)).id),
				cancel: () => done(null),
			}),
		);
		if (shown === undefined) return false;
		if (shown.result !== null) await this.thread(ui, cwd, shown.result);
		return true;
	}

	/** The thread view, and the start form when it asks to start again. False when this pi cannot show it. */
	async thread(ui: ExtensionUIContext, cwd: string, thread: string): Promise<boolean> {
		const shown = await this.custom<ScreenEnd>(ui, (tui, theme, keybindings, done) => this.screen(tui, theme, keybindings, done, cwd, thread), {
			overlay: true,
			overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left" },
		});
		if (shown === undefined) return false;
		const end = shown.result;
		if (end.kind === "start-again") await this.start(ui, cwd, { project: end.project, title: end.title });
		return true;
	}

	private screen(tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (end: ScreenEnd) => void, cwd: string, thread: string) {
		const stop = new AbortController();
		const signal = AbortSignal.any([stop.signal, this.closed]);
		const nexus = this.nexus;
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
			done,
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
				copy: (text) => copyToClipboard(text),
			},
		});
		const redraw = coalesced(drawEveryMs, () => screen.setView(view));
		let lastState: string | undefined;
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
			.catch((err: unknown) => {
				if (!signal.aborted) screen.say(`The watch ended: ${message(err)}`, true);
			});
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

