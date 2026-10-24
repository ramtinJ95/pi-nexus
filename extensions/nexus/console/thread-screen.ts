/**
 * The thread view: a Nexus thread as a pi session. The transcript is pi's own components, the composer is pi's
 * editor with the run's status in its top border as pi draws it, queued messages sit above it as pi's do, and a
 * footer below it names the thread and its pylon. It fills the screen as an overlay and scrolls by itself.
 *
 * It reads keys as vim does. Normal mode, where the view opens, moves through the Conversation, Details and Ports
 * views with vim's keys and pi's arrows; insert mode gives every key to the composer until Esc. The hint line under
 * the footer names the mode, and the composer shows its cursor and pi's border colour only in insert mode.
 */
import { CustomEditor, getSelectListTheme, rawKeyHint, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import {
	CombinedAutocompleteProvider,
	Loader,
	matchesKey,
	renderFakeCursor,
	SelectList,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type AutocompleteProvider,
	type Component,
	type Focusable,
	type TUI,
} from "@earendil-works/pi-tui";
import type { Action } from "../commands.ts";
import type { NodeSummary, Preview, ThreadDetail } from "../contract.ts";
import { portBusy, type ThreadView } from "../thread.ts";
import { detailLines, portLines } from "./inspector.ts";
import { helpLines, hint, KeyReader, type Binding } from "./keys.ts";
import {
	ago,
	archivedText,
	badge,
	blocks,
	composerOf,
	conversationItems,
	failedText,
	linkedPort,
	modelOf,
	parkedMessage,
	pausedText,
	portAction,
	portRows,
	runOf,
	shownOutputs,
	workingMessage,
	type Composer,
	noChange,
	shownPorts,
	type PortChange,
} from "./model.ts";
import { Transcript, type Display } from "./transcript.ts";

export interface ScreenActions {
	/** `requestId` is the same for a retry of the same text, so the API takes both as one message. */
	send(text: string, steer: boolean, requestId: string): Promise<void>;
	act(action: Action): Promise<void>;
	/** Publishes `port` of the pylon as a preview, and resolves once the node serves it. */
	preview(port: number): Promise<Preview>;
	/** Unpublishes the preview of `port`. */
	unpublish(port: number): Promise<void>;
	/** Reads the details again, which come back through setDetail. */
	refresh(): void;
	/** Follows the thread again after its watch ended, which then reports through watchEnded again. */
	rewatch(): void;
	/** Puts `text` on the system clipboard. */
	copy(text: string): Promise<void>;
}

/** `back` returns to where the view was opened from, `threads` opens the picker to switch, `close` leaves the console. */
export type ScreenEnd = { kind: "close" } | { kind: "back" } | { kind: "threads" } | { kind: "start-again"; project: string; title: string };

/** The thread view's slash commands, completed as pi completes its own. */
export const screenCommands: readonly { name: string; description: string; action?: Action }[] = [
	{ name: "steer", description: "join the current run after its tool round, instead of queueing" },
	{ name: "abort", description: "abort the agent's run", action: "abort" },
	{ name: "retry", description: "run the parked tasks again", action: "retry" },
	{ name: "retry-pylon", description: "boot a failed pylon again", action: "retry-pylon" },
	{ name: "start-again", description: "start a new thread on the same project" },
	{ name: "archive", description: "archive the thread, which pauses its pylon", action: "archive" },
	{ name: "unarchive", description: "unarchive the thread", action: "unarchive" },
	{ name: "delete", description: "delete the thread and its pylon, after asking", action: "delete" },
	{ name: "open", description: "publish a port of the pylon as a preview and link it" },
	{ name: "unpublish", description: "close a port's preview, so its link stops answering" },
	{ name: "copy", description: "copy a preview's link, by its port or its service" },
	{ name: "info", description: "show or hide the pylon, outputs and sessions" },
	{ name: "close", description: "close the thread view" },
];

const done: Readonly<Record<Action, string>> = {
	abort: "Aborted the run.",
	retry: "Retried the parked tasks.",
	"retry-pylon": "Retried the pylon.",
	archive: "Archived the thread.",
	unarchive: "Unarchived the thread.",
	delete: "Deleted the thread.",
};

type Tab = "conversation" | "details" | "ports";
const tabs: readonly { tab: Tab; label: string }[] = [
	{ tab: "conversation", label: "Conversation" },
	{ tab: "details", label: "Details" },
	{ tab: "ports", label: "Ports" },
];

type Command =
	| "insert"
	| "slash"
	| "down"
	| "up"
	| "halfDown"
	| "halfUp"
	| "pageDown"
	| "pageUp"
	| "top"
	| "bottom"
	| "left"
	| "right"
	| "nextTab"
	| "previousTab"
	| Tab
	| "activate"
	| "unpublish"
	| "copy"
	| "actions"
	| "refresh"
	| "threads"
	| "help"
	| "close"
	| "escape";

/**
 * Normal mode's keys, in the order the help lists them. They match the Claude Code Nexus mod's, which has only
 * single letters, and add vim's own where pi can read them, such as G, ctrl+d and ?.
 */
const threadKeys: readonly Binding<Command>[] = [
	{ keys: ["i", "a"], command: "insert", help: "write a message; esc, or enter with nothing written, stops writing" },
	{ keys: ["/"], command: "slash", help: "type a slash command, such as /open 8080" },
	{ keys: ["j", "down"], command: "down", help: "scroll down, or the next port" },
	{ keys: ["k", "up"], command: "up", help: "scroll up, or the previous port" },
	{ keys: ["d", "ctrl+d"], command: "halfDown", help: "half a page down" },
	{ keys: ["u", "ctrl+u"], command: "halfUp", help: "half a page up" },
	{ keys: ["pageDown"], command: "pageDown", help: "a page down" },
	{ keys: ["pageUp"], command: "pageUp", help: "a page up" },
	{ keys: ["gg", "home"], command: "top", help: "the top, or the first port" },
	{ keys: ["G", "ge", "end"], command: "bottom", help: "the end, which then follows the agent, or the last port" },
	{ keys: ["h", "left"], command: "left", help: "the view to the left; from the conversation, back where you came from" },
	{ keys: ["l", "right"], command: "right", help: "the view to the right" },
	{ keys: ["gt", "tab"], command: "nextTab", help: "the next view, round to the first" },
	{ keys: ["gT", "shift+tab"], command: "previousTab", help: "the previous view, round to the last" },
	{ keys: ["1"], command: "conversation", help: "the conversation" },
	{ keys: ["2"], command: "details", help: "the pylon, outputs, sessions and attach command" },
	{ keys: ["3"], command: "ports", help: "the previews and ports" },
	{ keys: ["enter", "o"], command: "activate", help: "publish the selected port" },
	{ keys: ["x"], command: "unpublish", help: "unpublish the selected port's own preview" },
	{ keys: ["y"], command: "copy", help: "copy the selected preview's link, or in Details the attach command" },
	{ keys: ["m", ":"], command: "actions", help: "the thread's actions: abort, retry, archive, delete and more" },
	{ keys: ["r"], command: "refresh", help: "read the thread's details again" },
	{ keys: ["t"], command: "threads", help: "the thread picker, to switch threads" },
	{ keys: ["s", "?"], command: "help", help: "this help" },
	{ keys: ["q"], command: "close", help: "close the console" },
	{ keys: ["escape"], command: "escape", help: "back to the conversation" },
];

type MenuCommand = "down" | "up" | "choose" | "cancel";
const menuKeys: readonly Binding<MenuCommand>[] = [
	{ keys: ["j", "down"], command: "down", help: "next" },
	{ keys: ["k", "up"], command: "up", help: "previous" },
	{ keys: ["enter", "o"], command: "choose", help: "choose" },
	{ keys: ["escape", "q"], command: "cancel", help: "cancel" },
];

/** The actions menu's entries, each shown while it can apply. */
type MenuEntry = Action | "start-again" | "copy-attach" | "rewatch";
interface MenuState {
	unwatched: boolean;
	working: boolean;
	parked: boolean;
	composer: Composer;
	status: string | undefined;
	loaded: boolean;
}
const menuEntries: readonly { entry: MenuEntry; label: string; description: string; when(s: MenuState): boolean }[] = [
	{ entry: "rewatch", label: "Watch again", description: "follow the thread again after its watch ended", when: (s) => s.unwatched },
	{ entry: "abort", label: "Abort the run", description: "abort the agent's run", when: (s) => s.working },
	{ entry: "retry", label: "Retry the parked tasks", description: "run the parked tasks again", when: (s) => s.parked },
	{ entry: "retry-pylon", label: "Retry the pylon", description: "boot a failed pylon again", when: (s) => s.composer.kind === "failed" },
	{ entry: "start-again", label: "Start again", description: "a new thread on the same project", when: (s) => s.loaded },
	{ entry: "archive", label: "Archive", description: "archive the thread, which pauses its pylon", when: (s) => s.status !== "archived" && s.status !== "deleted" },
	{ entry: "unarchive", label: "Unarchive", description: "bring the thread back", when: (s) => s.status === "archived" },
	{ entry: "copy-attach", label: "Copy the attach command", description: "to attach from a shell in the pylon", when: (s) => s.loaded },
	{ entry: "delete", label: "Delete", description: "the thread and its pylon, after asking", when: (s) => s.status !== "deleted" },
];

/** A list over the editor that vim's keys move through: the actions, or the delete question. */
interface Menu {
	title: string;
	list: SelectList;
	size: number;
	index: number;
	choose(value: string): void;
	cancel(): void;
}

/** Completes the slash commands only. The pylon's files are not on this machine, so there is no @ file completion. */
class CommandCompletion implements AutocompleteProvider {
	private readonly inner = new CombinedAutocompleteProvider(
		screenCommands.map((c) => ({ name: c.name, description: c.description })),
		"/",
	);

	getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options: { signal: AbortSignal; force?: boolean }) {
		const before = (lines[cursorLine] ?? "").slice(0, cursorCol).trimStart();
		if (cursorLine !== 0 || !before.startsWith("/") || before.includes(" ")) return Promise.resolve(null);
		return this.inner.getSuggestions(lines, cursorLine, cursorCol, options);
	}

	applyCompletion(...args: Parameters<CombinedAutocompleteProvider["applyCompletion"]>) {
		return this.inner.applyCompletion(...args);
	}

	shouldTriggerFileCompletion() {
		return false;
	}
}

/** pi's working indicator in the editor's top border. pi does not export its own, so this repeats its two methods. */
class RunStatus extends Loader {
	readonly kind = "working";

	renderInBorder(width: number): string {
		const line = super.render(width + 2)[1] ?? "";
		return truncateToWidth(line.startsWith(" ") ? line.slice(1).trimEnd() : line.trimEnd(), width, "");
	}

	renderSpinnerInBorder(width: number): string {
		return truncateToWidth(this.getRenderedIndicator(), width, "");
	}

	dispose(): void {
		this.stop();
	}
}
type BorderStatus = Parameters<CustomEditor["setWorkingStatusIndicator"]>[0];

/** pi's markers around the editor's cursor cell, which it draws as reverse video. Normal mode leaves them out. */
const [cursorStart, cursorEnd] = renderFakeCursor("|").split("|") as [string, string];

const queuedShown = 3;
/** The transcript lines that a pile of notes never takes. */
const minBody = 3;

/**
 * What the composer held when the person left a thread: its text, and the send that failed, whose request ID a retry
 * of the same text must reuse, since Nexus may have taken it before its reply was lost.
 */
export interface Draft {
	text: string;
	failed?: { text: string; steer: boolean; requestId: string };
}

export interface ScreenOptions {
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	display: Display;
	thread: string;
	actions: ScreenActions;
	done(end: ScreenEnd): void;
	/** What the composer held when the thread was last left. */
	draft?: Draft;
	now?: () => number;
}

export class ThreadScreen implements Component, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly editor: CustomEditor;
	private readonly transcript: Transcript;
	private readonly now: () => number;
	private readonly keys = new KeyReader(threadKeys);
	private readonly menuReader = new KeyReader(menuKeys);
	private view: ThreadView = { entries: [] };
	private detail: ThreadDetail | undefined;
	/** The last mark handed out, and the one the shown details were asked for at. */
	private marks = 0;
	private askedAt = 0;
	private nodes: readonly NodeSummary[] | Error | undefined;
	private body: Component[] = [];
	private status: { component: RunStatus; kind: "working" | "retry" } | undefined;
	private notice: { text: string; error: boolean } | undefined;
	private menu: Menu | undefined;
	private help = false;
	/** Whether the watch ended, so the view no longer follows the thread until it is watched again. */
	private unwatched = false;
	private outgoing: { text: string; steer: boolean; requestId: string; inFlight: boolean } | undefined;
	private readonly ticker: ReturnType<typeof setInterval>;
	private mode: "normal" | "insert" = "normal";
	private tab: Tab = "conversation";
	/** What the person did to each port from this view, by number. */
	private readonly portChanges = new Map<number, PortChange>();
	/** Each view's first shown line, and whether it sticks to its end, as the conversation does while the agent writes. */
	private readonly scrolls: Record<Tab, { top: number; following: boolean }> = {
		conversation: { top: 0, following: true },
		details: { top: 0, following: false },
		ports: { top: 0, following: false },
	};
	/** The selected row of the Ports view, and whether the next draw scrolls it into sight. */
	private port = 0;
	private reveal = false;
	private height = 1;
	private _focused = false;

	constructor(private readonly options: ScreenOptions) {
		this.tui = options.tui;
		this.theme = options.theme;
		this.now = options.now ?? Date.now;
		this.transcript = new Transcript(options.tui, options.theme, options.display);
		this.editor = new CustomEditor(
			options.tui,
			{ borderColor: this.borderColor(), selectList: getSelectListTheme() },
			options.keybindings,
			{ paddingX: options.display.editorPaddingX, embedWorkingStatus: true },
		);
		this.editor.setAutocompleteProvider(new CommandCompletion());
		this.editor.onSubmit = (text) => void this.submit(text);
		this.editor.onEscape = () => this.setMode("normal");
		this.editor.onAction("app.tools.expand", () => this.toggleExpanded());
		this.editor.onAction("app.clear", () => this.editor.setText(""));
		if (options.draft !== undefined) {
			this.editor.setText(options.draft.text);
			if (options.draft.failed !== undefined) this.outgoing = { ...options.draft.failed, inFlight: false };
		}
		this.ticker = setInterval(() => {
			this.updateStatus();
			this.tui.requestRender();
		}, 1000);
		this.ticker.unref?.();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value && this.mode === "insert";
	}

	/**
	 * pi colours its editor by the session's thinking level. A thread's level is not reported, so it reads as off.
	 * Normal mode mutes it, so the composer looks idle while keys move the view.
	 */
	private borderColor(): (s: string) => string {
		return this.mode === "insert" ? this.theme.getThinkingBorderColor("off") : (s) => this.theme.fg("borderMuted", s);
	}

	private setMode(mode: "normal" | "insert"): void {
		this.mode = mode;
		this.editor.borderColor = this.borderColor();
		this.focused = this._focused;
		this.tui.requestRender();
	}

	private toggleExpanded(): void {
		this.transcript.expanded = !this.transcript.expanded;
		this.rebuild();
	}

	setView(view: ThreadView): void {
		this.view = view;
		this.rebuild();
	}

	/**
	 * A point in this view's order of events, later than every one before: details asked for and operations
	 * confirmed. A sequence rather than a clock, so two events in the same millisecond still have an order.
	 */
	mark(): number {
		return ++this.marks;
	}

	/** `askedAt` is the mark taken when the details were asked for. */
	setDetail(detail: ThreadDetail, askedAt: number): void {
		this.detail = detail;
		this.askedAt = askedAt;
		this.updateStatus();
		this.tui.requestRender();
	}

	setNodes(nodes: readonly NodeSummary[] | Error): void {
		this.nodes = nodes;
		this.tui.requestRender();
	}

	private rebuild(): void {
		this.body = this.transcript.build(blocks(conversationItems(this.view.entries, this.view.live)));
		this.updateStatus();
		this.tui.requestRender();
	}

	private composer(): Composer {
		return composerOf(this.view.state, this.detail);
	}

	/** The run's status in the editor's border: working with its clock, or a model request waiting for its retry. */
	private updateStatus(): void {
		const { state, live } = this.view;
		const run = runOf(state, conversationItems(this.view.entries, live));
		const want = live?.retry ? "retry" : run.kind === "working" ? "working" : undefined;
		if (this.status?.kind !== want) {
			this.status?.component.dispose();
			this.status = undefined;
			if (want !== undefined) {
				const t = this.theme;
				const component =
					want === "retry"
						? new RunStatus(this.tui, (s) => t.fg("warning", s), (s) => t.fg("muted", s), "")
						: new RunStatus(this.tui, (s) => this.editor.borderColor(s), (s) => this.editor.borderColor(s), "");
				this.status = { component, kind: want };
			}
			this.editor.setWorkingStatusIndicator(this.status?.component as BorderStatus);
		}
		if (this.status?.kind === "retry") this.status.component.setMessage(`The model request failed and will be retried: ${live!.retry}`);
		else if (this.status && run.kind === "working") this.status.component.setMessage(workingMessage(run, this.now(), state?.status === "archived"));
	}

	/**
	 * The watch ended, with why when it failed. Nexus ends a deleted thread's watch, which has nothing left to follow,
	 * so that end says nothing and the delete's own note stays.
	 */
	watchEnded(why: string | undefined): void {
		if ((this.view.state?.status ?? this.detail?.thread.status) === "deleted") return;
		this.unwatched = true;
		this.say(`The watch ended${why === undefined ? "" : `: ${why}`}. m, then Watch again, follows the thread again.`, why !== undefined);
	}

	private rewatch(): void {
		this.unwatched = false;
		this.say("Watching the thread again...");
		this.options.actions.rewatch();
	}

	/** What the composer holds, unsent, with the send that failed. A send still in flight counts as failed once left. */
	get draft(): Draft {
		const text = this.editor.getText();
		if (this.outgoing === undefined) return { text };
		const { text: sent, steer, requestId } = this.outgoing;
		return { text, failed: { text: sent, steer, requestId } };
	}

	say(text: string, error = false): void {
		this.notice = { text, error };
		this.tui.requestRender();
	}

	/** A known slash command runs; any other text is a message, as pi sends a slash it does not know to the model. */
	async submit(text: string): Promise<void> {
		const trimmed = text.trim();
		// An empty Enter leaves insert mode, as the Claude Code mod's composer does.
		if (trimmed === "") return this.setMode("normal");
		this.notice = undefined;
		const [word = "", ...rest] = trimmed.split(/\s+/);
		const command = word.startsWith("/") ? screenCommands.find((c) => c.name === word.slice(1)) : undefined;
		if (command === undefined) return this.send(text, false);
		this.editor.addToHistory(trimmed);
		const argument = trimmed.slice(word.length).trim();
		switch (command.name) {
			case "steer":
				if (rest.length === 0) return this.say("/steer needs the text to send.", true);
				return this.send(argument, true);
			case "info":
				return this.show(this.tab === "details" ? "conversation" : "details");
			case "close":
				return this.options.done({ kind: "close" });
			case "start-again":
				return this.startAgain();
			case "delete":
				return this.askDelete();
			case "open":
				return this.openPort(argument);
			case "unpublish":
				return this.unpublishPort(argument);
			case "copy":
				return this.copyLink(argument);
			default:
				return this.act(command.action!);
		}
	}

	private startAgain(): void {
		const t = this.detail?.thread;
		if (t === undefined) return this.say("The thread's details have not loaded yet.", true);
		this.options.done({ kind: "start-again", project: t.project, title: t.title });
	}

	private refusal(composer: Composer): string | undefined {
		switch (composer.kind) {
			case "closed":
				return composer.reason;
			case "failed":
				return "The pylon failed, so the thread takes no messages.";
			case "archived":
				return archivedText;
			case "open":
				return undefined;
		}
	}

	/**
	 * Sends or, while the run is busy, queues `text`. Sending the same text the same way again after a failure reuses
	 * its request ID, so a send whose reply was lost is not taken twice. The API keeps the first send's mode for an ID
	 * it has seen, so steering text first sent as a follow-up is a new message. A failed send puts the text back.
	 */
	private async send(text: string, steer: boolean): Promise<void> {
		const refused = this.refusal(this.composer());
		const restore = () => {
			if (this.editor.getText() === "") this.editor.setText(steer ? `/steer ${text}` : text);
		};
		if (refused !== undefined) {
			restore();
			return this.say(refused, true);
		}
		if (this.outgoing?.inFlight) return restore();
		if (this.outgoing?.text !== text || this.outgoing.steer !== steer) {
			this.outgoing = { text, steer, requestId: `msg:${crypto.randomUUID()}`, inFlight: false };
		}
		const outgoing = this.outgoing;
		outgoing.inFlight = true;
		this.editor.disableSubmit = true;
		try {
			await this.options.actions.send(text, steer, outgoing.requestId);
			this.editor.addToHistory(steer ? `/steer ${text}` : text);
			this.outgoing = undefined;
			this.scrolls.conversation.following = true;
		} catch (err) {
			outgoing.inFlight = false;
			restore();
			this.say(`The message was not sent: ${err instanceof Error ? err.message : String(err)}`, true);
		} finally {
			this.editor.disableSubmit = false;
			this.tui.requestRender();
		}
	}

	private async act(action: Action): Promise<void> {
		try {
			await this.options.actions.act(action);
			this.say(done[action]);
		} catch (err) {
			this.say(`/${action} failed: ${err instanceof Error ? err.message : String(err)}`, true);
		}
	}

	/**
	 * Publishes a port as a preview, saying so while the CLI waits for the node to serve it, then shows it under
	 * Previews until details read after it list it. A failure says why, and /open tries again.
	 */
	private async openPort(argument: string): Promise<void> {
		const port = this.portArgument("open", argument);
		if (port === undefined) return;
		this.say(`Opening port ${port}: publishing it and waiting for the node to serve its URL...`);
		const preview = await this.changePort(port, "open", () => this.options.actions.preview(port));
		if (preview instanceof Error) this.say(`Port ${port} did not open: ${preview.message}`, true);
		else this.say(`Port ${port} is open at ${preview.url}`);
	}

	/** Unpublishes a port's preview, saying so while the CLI wakes a paused pylon, and why when it fails. */
	private async unpublishPort(argument: string): Promise<void> {
		const port = this.portArgument("unpublish", argument);
		if (port === undefined) return;
		this.say(`Unpublishing port ${port}...`);
		const done = await this.changePort(port, "close", async () => (await this.options.actions.unpublish(port), null));
		if (done instanceof Error) this.say(`Port ${port} was not unpublished: ${done.message}`, true);
		else this.say(`Port ${port} is unpublished. /open ${port} publishes it again, maybe at a new URL.`);
	}

	/**
	 * Runs `action` on `port` as pending, then keeps the preview it confirmed, null once unpublished, with when it
	 * ended, or its failure beside what was confirmed before.
	 */
	private async changePort<T extends Preview | null>(port: number, action: "open" | "close", run: () => Promise<T>): Promise<T | Error> {
		const was = this.portChanges.get(port) ?? noChange;
		this.portChanges.set(port, { ...was, pending: action, failure: null });
		try {
			const preview = await run();
			this.portChanges.set(port, { confirmed: { preview, at: this.mark() }, pending: null, failure: null });
			// Asked for after the confirmation, so details that show the port otherwise, after another client
			// changed it, are shown.
			this.options.actions.refresh();
			return preview;
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			this.portChanges.set(port, { ...(this.portChanges.get(port) ?? noChange), pending: null, failure: { action, message: error.message } });
			return error;
		}
	}

	/** The port `/<command>` names, or undefined once it has said why there is none or why it must wait. */
	private portArgument(command: string, argument: string): number | undefined {
		const port = Number(argument);
		if (!/^\d+$/.test(argument) || port < 1 || port > 65535) {
			this.say(`/${command} needs a port number, such as /${command} 8080.`, true);
			return undefined;
		}
		const pending = this.portChanges.get(port)?.pending;
		if (pending) {
			this.say(portBusy(this.options.thread, port));
			return undefined;
		}
		return port;
	}

	/** The previews and ports as shown: the details with what the person confirmed since they were read. */
	private shown() {
		return shownPorts(this.detail ?? { previews: [], ports: null }, this.portChanges, this.askedAt);
	}

	/** The link of the preview that `ref`, a port or a service, names. */
	private linkOf(ref: string): string | undefined {
		const shown = this.shown();
		return (
			shown?.ports?.find((p) => String(p.port) === ref)?.preview?.url ??
			shown?.previews.find((p) => p.service === ref || String(linkedPort(p.service)) === ref)?.url
		);
	}

	private async copyLink(argument: string): Promise<void> {
		if (argument === "") return this.say("/copy needs a port or a service, such as /copy 5173.", true);
		const url = this.linkOf(argument);
		if (url === undefined) return this.say(`No preview has the port or service ${argument}.`, true);
		return this.copy(url);
	}

	private async copy(text: string): Promise<void> {
		try {
			await this.options.actions.copy(text);
			this.say(`Copied ${text}`);
		} catch (err) {
			this.say(`The link was not copied: ${err instanceof Error ? err.message : String(err)}`, true);
		}
	}

	private openMenu(title: string, items: { value: string; label: string; description?: string }[], choose: (value: string) => void, cancel = () => {}): void {
		const list = new SelectList(items, items.length, getSelectListTheme());
		this.menu = {
			title,
			list,
			size: items.length,
			index: 0,
			choose: (value) => {
				this.menu = undefined;
				choose(value);
			},
			cancel: () => {
				this.menu = undefined;
				cancel();
			},
		};
		this.tui.requestRender();
	}

	/** Keep comes first, so the highlighted answer and Esc both keep the thread. */
	private askDelete(): void {
		const kept = () => this.say("Kept the thread.");
		this.openMenu(
			`Delete ${this.options.thread}? Its pylon is deleted for good.`,
			[
				{ value: "keep", label: "Keep" },
				{ value: "delete", label: "Delete" },
			],
			(value) => (value === "delete" ? void this.act("delete") : kept()),
			kept,
		);
	}

	private openActions(): void {
		const run = runOf(this.view.state, []);
		const state: MenuState = {
			unwatched: this.unwatched,
			working: run.kind === "working",
			parked: run.kind === "parked",
			composer: this.composer(),
			status: this.view.state?.status ?? this.detail?.thread.status,
			loaded: this.detail !== undefined,
		};
		const entries = menuEntries.filter((e) => e.when(state));
		this.openMenu(
			"Actions",
			entries.map((e) => ({ value: e.entry, label: e.label, description: e.description })),
			(value) => {
				const entry = value as MenuEntry;
				if (entry === "start-again") return this.startAgain();
				if (entry === "copy-attach") return void this.copy(this.detail!.attach);
				if (entry === "delete") return this.askDelete();
				if (entry === "rewatch") return this.rewatch();
				void this.act(entry);
			},
		);
	}

	private menuInput(menu: Menu, data: string): void {
		switch (this.menuReader.read(data)) {
			case "down":
				menu.index = Math.min(menu.size - 1, menu.index + 1);
				return menu.list.setSelectedIndex(menu.index);
			case "up":
				menu.index = Math.max(0, menu.index - 1);
				return menu.list.setSelectedIndex(menu.index);
			case "choose":
				return menu.choose(menu.list.getSelectedItem()!.value);
			case "cancel":
				return menu.cancel();
		}
	}

	handleInput(data: string): void {
		if (this.menu) this.menuInput(this.menu, data);
		else if (this.help) this.help = false;
		else if (this.mode === "insert") {
			if (matchesKey(data, "pageUp")) this.scroll(-this.page());
			else if (matchesKey(data, "pageDown")) this.scroll(this.page());
			else this.editor.handleInput(data);
		} else if (this.options.keybindings.matches(data, "app.tools.expand")) this.toggleExpanded();
		else {
			const command = this.keys.read(data);
			if (command !== undefined) this.run(command);
		}
		this.tui.requestRender();
	}

	private run(command: Command): void {
		const half = Math.max(1, Math.floor(this.height / 2));
		switch (command) {
			case "insert":
				return this.setMode("insert");
			case "slash":
				this.setMode("insert");
				return this.editor.handleInput("/");
			case "down":
				return this.tab === "ports" ? this.select(this.port + 1) : this.scroll(1);
			case "up":
				return this.tab === "ports" ? this.select(this.port - 1) : this.scroll(-1);
			case "halfDown":
				return this.scroll(half);
			case "halfUp":
				return this.scroll(-half);
			case "pageDown":
				return this.scroll(this.page());
			case "pageUp":
				return this.scroll(-this.page());
			case "top":
				if (this.tab === "ports") return this.select(0);
				this.scrolls[this.tab] = { top: 0, following: false };
				return;
			case "bottom":
				if (this.tab === "ports") return this.select(Number.MAX_SAFE_INTEGER);
				this.scrolls[this.tab].following = true;
				return;
			case "left":
				if (this.tab === "conversation") return this.options.done({ kind: "back" });
				return this.show(tabs[tabs.findIndex((t) => t.tab === this.tab) - 1]!.tab);
			case "right":
				return this.show(tabs[Math.min(tabs.length - 1, tabs.findIndex((t) => t.tab === this.tab) + 1)]!.tab);
			case "nextTab":
			case "previousTab": {
				const at = tabs.findIndex((t) => t.tab === this.tab) + (command === "nextTab" ? 1 : -1);
				return this.show(tabs[(at + tabs.length) % tabs.length]!.tab);
			}
			case "conversation":
			case "details":
			case "ports":
				return this.show(command);
			case "activate":
				return this.activate("open");
			case "unpublish":
				return this.activate("unpublish");
			case "refresh":
				this.options.actions.refresh();
				return this.say("Reading the thread's details again...");
			case "copy":
				return this.copySelected();
			case "actions":
				return this.openActions();
			case "threads":
				return this.options.done({ kind: "threads" });
			case "help":
				this.help = true;
				return;
			case "close":
				return this.options.done({ kind: "close" });
			case "escape":
				if (this.tab !== "conversation") this.show("conversation");
				return;
		}
	}

	private show(tab: Tab): void {
		this.tab = tab;
		this.tui.requestRender();
	}

	private page(): number {
		return Math.max(1, this.height - 1);
	}

	private scroll(by: number): void {
		const s = this.scrolls[this.tab];
		s.following = false;
		s.top = Math.max(0, s.top + by);
		this.tui.requestRender();
	}

	private select(row: number): void {
		const rows = portRows(this.shown()).length;
		this.port = Math.max(0, Math.min(rows - 1, row));
		this.reveal = true;
	}

	private selectedRow() {
		return portRows(this.shown())[this.port];
	}

	/** Enter or x on a port row: publishes a port with no preview, or unpublishes a port's own preview. */
	private activate(want: "open" | "unpublish"): void {
		if (this.tab !== "ports") return this.say(`${want === "open" ? "Enter publishes" : "x unpublishes"} the port selected in the Ports view, which l or 3 shows.`);
		const row = this.selectedRow();
		if (row === undefined) return this.say("No port listens yet.");
		const port = row.kind === "port" ? row.port.port : row.port;
		const canRun = this.detail?.thread.status === "active" || this.detail?.thread.status === "idle";
		const action = portAction(this.options.thread, row, port === undefined ? noChange : (this.portChanges.get(port) ?? noChange), canRun, want);
		if (action.kind === "none") return this.say(action.why);
		void (action.kind === "open" ? this.openPort(String(action.port)) : this.unpublishPort(String(action.port)));
	}

	/** y: the selected preview's link in Ports, the attach command in Details. */
	private copySelected(): void {
		if (this.tab === "details" && this.detail) return void this.copy(this.detail.attach);
		const row = this.tab === "ports" ? this.selectedRow() : undefined;
		if (row?.kind !== "preview") return this.say("y copies a preview's link selected in Ports, or the attach command in Details.");
		void this.copy(row.preview.url);
	}

	private notes(width: number): string[] {
		const t = this.theme;
		const pad = " ".repeat(this.options.display.outputPad);
		const wrap = (text: string, color: "error" | "warning" | "muted" | "dim") =>
			wrapTextWithAnsi(text, Math.max(10, width - 2 * pad.length)).map((line) => pad + t.fg(color, line));
		const out: string[] = [];
		const queued = this.view.live?.queued ?? [];
		if (queued.length > 0) {
			const shown = queued.slice(0, queuedShown).map((q) => truncateToWidth(pad + t.fg("dim", `Queued: ${q.replace(/\s+/g, " ")}`), width));
			const more = queued.length - queuedShown;
			out.push("", ...shown, ...(more > 0 ? [pad + t.fg("dim", `and ${more} more queued`)] : []));
		}
		const run = this.view.state;
		const composer = this.composer();
		const archived = run?.status === "archived";
		const lines: string[] = [];
		if (run?.run === "parked") lines.push(...wrap(`⚠ ${parkedMessage(run.parkedTasks, archived)}`, "warning"));
		if (composer.kind === "failed") {
			lines.push(...wrap(failedText(composer.refused), "error"));
			lines.push(...wrap(composer.failed, "dim"));
		} else if (composer.kind === "archived") lines.push(...wrap(archivedText, "muted"));
		else if (composer.kind === "closed") lines.push(...wrap(composer.reason, "muted"));
		else if (composer.paused) lines.push(...wrap(pausedText, "muted"));
		if (this.view.outage) lines.push(...wrap(`${this.view.outage} Still watching.`, "error"));
		if (this.notice) lines.push(...wrap(this.notice.text, this.notice.error ? "error" : "muted"));
		if (lines.length > 0) out.push("", ...lines);
		return out;
	}

	/** The views by name, the shown one in the accent colour, with their keys. */
	private tabLine(width: number): string {
		const t = this.theme;
		const ports = portRows(this.shown()).length;
		const parts = tabs.map(({ tab, label }, i) => {
			const name = `${label}${tab === "ports" && ports > 0 ? ` ${ports}` : ""}`;
			return `${t.fg("dim", String(i + 1))} ${tab === this.tab ? t.fg("accent", t.bold(name)) : t.fg("muted", name)}`;
		});
		return truncateToWidth(` ${parts.join("   ")}`, width);
	}

	private footer(width: number): string[] {
		const t = this.theme;
		const d = this.detail;
		const title = d ? `${d.thread.project} / ${d.thread.title}` : this.options.thread;
		const line1 = truncateToWidth(t.fg("dim", d ? `${title} (${this.options.thread})` : title), width);
		const parts: string[] = [];
		if (d) {
			const actual = this.view.state?.pylon ?? d.pylon.actualState;
			parts.push(`pylon ${badge(actual)[0]} on ${d.pylon.node}`);
			if (d.pylon.observedAt !== null) parts.push(`seen ${ago(Date.parse(d.pylon.observedAt), this.now())}`);
			parts.push(`wanted ${d.desired}`);
			const shown = this.shown();
			const previews = shown.previews.length;
			const outputs = shownOutputs({ ...d, ...shown }).length;
			parts.push(`${previews} ${previews === 1 ? "preview" : "previews"}`, `${outputs} ${outputs === 1 ? "output" : "outputs"}`);
		}
		const left = parts.join(" · ");
		const model = modelOf(this.view.entries) ?? "";
		const room = width - visibleWidth(left) - visibleWidth(model);
		const line2 = room >= 2 ? `${left}${" ".repeat(room)}${model}` : left;
		return [line1, truncateToWidth(t.fg("dim", line2), width), this.hints(width)];
	}

	/** The mode, then the keys that work there, in pi's hint style, under the footer. */
	private hints(width: number): string {
		const t = this.theme;
		const k = (command: Command, description: string) => hint(threadKeys, command, description);
		// pi's own tool expand key, as the user bound it.
		const expand = rawKeyHint(this.options.keybindings.getKeys("app.tools.expand").join("/"), "expand tools");
		let keys: string[];
		if (this.menu) keys = [rawKeyHint("j/k", "move"), rawKeyHint("enter", "choose"), rawKeyHint("esc", "cancel")];
		else if (this.help) keys = [rawKeyHint("any key", "closes the help")];
		else if (this.mode === "insert") keys = [rawKeyHint("esc", "normal mode"), rawKeyHint("enter", "send"), rawKeyHint("/", "commands"), rawKeyHint("pgup/pgdn", "scroll"), expand];
		else {
			const move =
				this.tab === "ports"
					? [rawKeyHint("j/k", "select"), k("activate", "publish"), k("unpublish", "unpublish"), k("copy", "copy")]
					: [rawKeyHint("j/k", "scroll"), rawKeyHint("d/u", "half page")];
			keys = [k("insert", "write"), ...move, rawKeyHint("h/l", "views"), k("actions", "actions"), k("help", "keys"), k("close", "close"), ...(this.tab === "conversation" ? [expand] : [])];
		}
		const mode = this.mode === "insert" ? t.bold(t.fg("success", "INSERT")) : t.bold(t.fg("accent", "NORMAL"));
		const waiting = this.keys.waiting === "" ? "" : `  ${t.fg("muted", this.keys.waiting)}`;
		return truncateToWidth(`${mode}${waiting}  ${keys.join("  ")}`, width);
	}

	private helpLines(width: number): string[] {
		const t = this.theme;
		const rows = [...helpLines(threadKeys), { keys: this.options.keybindings.getKeys("app.tools.expand").join("/"), help: "expand or fold tool output, as in pi" }];
		const column = Math.max(...rows.map((r) => visibleWidth(r.keys))) + 2;
		return [
			` ${t.fg("accent", t.bold("Keys in normal mode"))}`,
			"",
			...rows.map((r) => truncateToWidth(`   ${t.fg("dim", r.keys.padEnd(column))}${t.fg("muted", r.help)}`, width)),
			"",
			...wrapTextWithAnsi("In insert mode every key goes to the composer, as in pi: Enter sends, / starts a command, and Esc or an empty Enter returns to normal mode.", Math.max(10, width - 4)).map((l) => `   ${t.fg("dim", l)}`),
		];
	}

	/** The shown view's lines, and the selected port row's first and last line in the Ports view. */
	private bodyLines(width: number): { lines: string[]; focus?: [number, number] } {
		if (this.help) return { lines: ["", ...this.helpLines(width)] };
		switch (this.tab) {
			case "conversation":
				return { lines: this.body.flatMap((c) => c.render(width)) };
			case "details":
				return { lines: ["", ...detailLines(this.theme, this.detail, this.nodes, this.shown(), this.now(), width)] };
			case "ports": {
				const shown = this.shown();
				this.port = Math.max(0, Math.min(portRows(shown).length - 1, this.port));
				const { lines, rows } = portLines(this.theme, this.detail, shown, this.portChanges, this.port, width);
				const focus = rows[this.port];
				return { lines: ["", ...lines], ...(focus ? { focus: [focus[0] + 1, focus[1] + 1] as [number, number] } : {}) };
			}
		}
	}

	render(width: number): string[] {
		const t = this.theme;
		const rows = Math.max(5, this.tui.terminal.rows);
		// A blank line always sits above the editor, as pi's empty widget area leaves one.
		const editor = [
			"",
			...(this.menu
				? [` ${t.fg("accent", t.bold(this.menu.title))}`, ...this.menu.list.render(width)]
				: this.editor.render(width).map((line) => (this.mode === "insert" ? line : line.replaceAll(cursorStart, "").replaceAll(cursorEnd, "")))),
		];
		const footer = this.footer(width);
		const top = [this.tabLine(width)];
		// The tabs, editor and footer always show. Notes get what is left beside a few lines of the view, newest kept.
		const room = Math.max(0, rows - top.length - editor.length - footer.length - minBody);
		const notes = this.notes(width);
		const bottom = [...(notes.length > room ? notes.slice(notes.length - room) : notes), ...editor, ...footer];
		const height = Math.max(1, rows - top.length - bottom.length);
		this.height = height;
		const { lines: body, focus } = this.bodyLines(width);
		const s = this.help ? { top: 0, following: false } : this.scrolls[this.tab];
		const end = Math.max(0, body.length - height);
		if (focus && this.reveal) {
			if (focus[0] < s.top) s.top = focus[0];
			else if (focus[1] >= s.top + height) s.top = Math.min(focus[0], focus[1] - height + 1);
			s.following = false;
		}
		this.reveal = false;
		if (s.following || s.top >= end) {
			s.following = true;
			s.top = end;
		}
		const shown = body.slice(s.top, s.top + height);
		if (!s.following) {
			const more = end - s.top;
			shown[shown.length - 1] = ` ${t.fg("dim", `↓ ${more} more ${more === 1 ? "line" : "lines"}${this.tab === "conversation" && !this.help ? ", G follows the end" : ""}`)}`;
		}
		const lines = [...top, ...shown, ...bottom];
		while (lines.length < rows) lines.push("");
		return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		for (const c of this.body) c.invalidate();
		this.editor.invalidate();
	}

	dispose(): void {
		clearInterval(this.ticker);
		this.status?.component.dispose();
		this.editor.setWorkingStatusIndicator(undefined);
	}
}
