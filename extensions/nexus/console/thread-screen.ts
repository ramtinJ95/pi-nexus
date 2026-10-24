/**
 * The thread view: a Nexus thread as a pi session. The transcript is pi's own components, the composer is pi's
 * editor with the run's status in its top border as pi draws it, queued messages sit above it as pi's do, and a
 * footer below it names the thread and its pylon. It fills the screen as an overlay and scrolls by itself.
 */
import { CustomEditor, getSelectListTheme, rawKeyHint, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import {
	CombinedAutocompleteProvider,
	Loader,
	matchesKey,
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
import type { ThreadView } from "../thread.ts";
import { inspectorLines } from "./inspector.ts";
import {
	ago,
	archivedText,
	badge,
	blocks,
	composerOf,
	conversationItems,
	failedText,
	modelOf,
	parkedMessage,
	pausedText,
	runOf,
	shownOutputs,
	workingMessage,
	type Composer,
	type Opening,
} from "./model.ts";
import { Transcript, type Display } from "./transcript.ts";

export interface ScreenActions {
	/** `requestId` is the same for a retry of the same text, so the API takes both as one message. */
	send(text: string, steer: boolean, requestId: string): Promise<void>;
	act(action: Action): Promise<void>;
	/** Publishes `port` of the pylon as a preview, and resolves once the node serves it. */
	preview(port: number): Promise<Preview>;
	/** Puts `text` on the system clipboard. */
	copy(text: string): Promise<void>;
}

export type ScreenEnd = { kind: "close" } | { kind: "start-again"; project: string; title: string };

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
	{ name: "copy", description: "copy a preview's link, by its port or its service" },
	{ name: "info", description: "show or hide the pylon, previews, ports, outputs and sessions" },
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

const queuedShown = 3;
/** The transcript lines that a pile of notes never takes. */
const minBody = 3;

export interface ScreenOptions {
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	display: Display;
	thread: string;
	actions: ScreenActions;
	done(end: ScreenEnd): void;
	now?: () => number;
}

export class ThreadScreen implements Component, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly editor: CustomEditor;
	private readonly transcript: Transcript;
	private readonly now: () => number;
	private view: ThreadView = { entries: [] };
	private detail: ThreadDetail | undefined;
	private nodes: readonly NodeSummary[] | Error | undefined;
	private body: Component[] = [];
	private status: { component: RunStatus; kind: "working" | "retry" } | undefined;
	private notice: { text: string; error: boolean } | undefined;
	private confirm: SelectList | undefined;
	private outgoing: { text: string; steer: boolean; requestId: string; inFlight: boolean } | undefined;
	private readonly ticker: ReturnType<typeof setInterval>;
	inspecting = false;
	/** The ports opened from this view, by number. */
	private readonly openings = new Map<number, Opening>();
	/** Whether the transcript sticks to its end, and its first shown line when it does not. */
	private following = true;
	private top = 0;
	private height = 1;
	private _focused = false;

	constructor(private readonly options: ScreenOptions) {
		this.tui = options.tui;
		this.theme = options.theme;
		this.now = options.now ?? Date.now;
		this.transcript = new Transcript(options.tui, options.theme, options.display);
		this.editor = new CustomEditor(
			options.tui,
			// pi colours its editor by the session's thinking level. A thread's level is not reported, so it reads as off.
			{ borderColor: options.theme.getThinkingBorderColor("off"), selectList: getSelectListTheme() },
			options.keybindings,
			{ paddingX: options.display.editorPaddingX, embedWorkingStatus: true },
		);
		this.editor.setAutocompleteProvider(new CommandCompletion());
		this.editor.onSubmit = (text) => void this.submit(text);
		this.editor.onEscape = () => this.escape();
		this.editor.onCtrlD = () => this.options.done({ kind: "close" });
		this.editor.onAction("app.tools.expand", () => {
			this.transcript.expanded = !this.transcript.expanded;
			this.rebuild();
		});
		this.editor.onAction("app.clear", () => this.editor.setText(""));
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
		this.editor.focused = value;
	}

	setView(view: ThreadView): void {
		this.view = view;
		this.rebuild();
	}

	setDetail(detail: ThreadDetail): void {
		this.detail = detail;
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

	private escape(): void {
		if (this.inspecting) {
			this.inspecting = false;
			this.tui.requestRender();
		} else this.options.done({ kind: "close" });
	}

	say(text: string, error = false): void {
		this.notice = { text, error };
		this.tui.requestRender();
	}

	/** A known slash command runs; any other text is a message, as pi sends a slash it does not know to the model. */
	async submit(text: string): Promise<void> {
		const trimmed = text.trim();
		if (trimmed === "") return;
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
				this.inspecting = !this.inspecting;
				return this.tui.requestRender();
			case "close":
				return this.options.done({ kind: "close" });
			case "start-again": {
				const t = this.detail?.thread;
				if (t === undefined) return this.say("The thread's details have not loaded yet.", true);
				return this.options.done({ kind: "start-again", project: t.project, title: t.title });
			}
			case "delete":
				return this.askDelete();
			case "open":
				return this.openPort(argument);
			case "copy":
				return this.copyLink(argument);
			default:
				return this.act(command.action!);
		}
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
			this.following = true;
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
	 * Publishes a port as a preview, saying so while the CLI waits for the node to serve it, then links it until the
	 * next details list it under Previews. A failure says why, and /open tries again.
	 */
	private async openPort(argument: string): Promise<void> {
		const port = Number(argument);
		if (!/^\d+$/.test(argument) || port < 1 || port > 65535) return this.say("/open needs a port number, such as /open 5173.", true);
		if (this.openings.get(port)?.phase === "opening") return this.say(`Port ${port} is opening already.`);
		this.openings.set(port, { phase: "opening" });
		this.say(`Opening port ${port}: publishing it and waiting for the node to serve its URL...`);
		try {
			const preview = await this.options.actions.preview(port);
			this.openings.set(port, { phase: "open", preview });
			this.say(`Port ${port} is open at ${preview.url}`);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.openings.set(port, { phase: "failed", message });
			this.say(`Port ${port} did not open: ${message}`, true);
		}
	}

	/** The link of the preview that `ref`, a port or a service, names. */
	private linkOf(ref: string): string | undefined {
		const opened = this.openings.get(Number(ref));
		return (
			this.detail?.ports?.find((p) => String(p.port) === ref)?.preview?.url ??
			(opened?.phase === "open" ? opened.preview.url : undefined) ??
			this.detail?.previews.find((p) => p.service === ref)?.url
		);
	}

	private async copyLink(argument: string): Promise<void> {
		if (argument === "") return this.say("/copy needs a port or a service, such as /copy 5173.", true);
		const url = this.linkOf(argument);
		if (url === undefined) return this.say(`No preview has the port or service ${argument}.`, true);
		try {
			await this.options.actions.copy(url);
			this.say(`Copied ${url}`);
		} catch (err) {
			this.say(`The link was not copied: ${err instanceof Error ? err.message : String(err)}`, true);
		}
	}

	/** Keep comes first, so the highlighted answer and Esc both keep the thread. */
	private askDelete(): void {
		const list = new SelectList(
			[
				{ value: "keep", label: "Keep" },
				{ value: "delete", label: "Delete" },
			],
			2,
			getSelectListTheme(),
		);
		list.onSelect = (item) => {
			this.confirm = undefined;
			if (item.value === "delete") void this.act("delete");
			else this.say("Kept the thread.");
		};
		list.onCancel = () => {
			this.confirm = undefined;
			this.say("Kept the thread.");
		};
		this.confirm = list;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.confirm) {
			this.confirm.handleInput(data);
			return this.tui.requestRender();
		}
		if (matchesKey(data, "pageUp")) return this.scroll(-Math.max(1, this.height - 1));
		if (matchesKey(data, "pageDown")) return this.scroll(Math.max(1, this.height - 1));
		if (matchesKey(data, "alt+i")) {
			this.inspecting = !this.inspecting;
			return this.tui.requestRender();
		}
		this.editor.handleInput(data);
		this.tui.requestRender();
	}

	private scroll(by: number): void {
		this.following = false;
		this.top = Math.max(0, this.top + by);
		this.tui.requestRender();
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
			const outputs = shownOutputs(d).length;
			parts.push(`${d.previews.length} ${d.previews.length === 1 ? "preview" : "previews"}`, `${outputs} ${outputs === 1 ? "output" : "outputs"}`);
		}
		const left = parts.join(" · ");
		const model = modelOf(this.view.entries) ?? "";
		const room = width - visibleWidth(left) - visibleWidth(model);
		const line2 = room >= 2 ? `${left}${" ".repeat(room)}${model}` : left;
		return [line1, truncateToWidth(t.fg("dim", line2), width), this.hints(width)];
	}

	/** The keys that work on this screen, in pi's hint style, under the footer. */
	private hints(width: number): string {
		const keys = this.inspecting
			? [rawKeyHint("esc", "transcript"), rawKeyHint("pgup/pgdn", "scroll"), rawKeyHint("/", "commands")]
			: [
					rawKeyHint("esc", "close"),
					rawKeyHint("pgup/pgdn", "scroll"),
					// pi's own tool expand key, as the user bound it.
					rawKeyHint(this.options.keybindings.getKeys("app.tools.expand").join("/"), "expand tools"),
					rawKeyHint("alt+i", "info"),
					rawKeyHint("/", "commands"),
				];
		return truncateToWidth(keys.join("  "), width);
	}

	render(width: number): string[] {
		const rows = Math.max(4, this.tui.terminal.rows);
		// A blank line always sits above the editor, as pi's empty widget area leaves one.
		const editor = [
			"",
			...(this.confirm
				? [` ${this.theme.fg("accent", this.theme.bold(`Delete ${this.options.thread}? Its pylon is deleted for good.`))}`, ...this.confirm.render(width)]
				: this.editor.render(width)),
		];
		const footer = this.footer(width);
		// The editor and footer always show. Notes get what is left beside a few transcript lines, newest kept.
		const room = Math.max(0, rows - editor.length - footer.length - minBody);
		const notes = this.notes(width);
		const bottom = [...(notes.length > room ? notes.slice(notes.length - room) : notes), ...editor, ...footer];
		const height = Math.max(1, rows - bottom.length);
		this.height = height;
		const body = this.inspecting
			? ["", ...inspectorLines(this.theme, this.detail, this.nodes, this.openings, this.now(), width)]
			: this.body.flatMap((c) => c.render(width));
		const end = Math.max(0, body.length - height);
		if (this.following || this.top >= end) {
			this.following = true;
			this.top = end;
		}
		const shown = body.slice(this.top, this.top + height);
		if (!this.following) shown[shown.length - 1] = ` ${this.theme.fg("dim", `↓ ${end - this.top} more lines, pgdn to scroll`)}`;
		const lines = [...shown, ...bottom];
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
