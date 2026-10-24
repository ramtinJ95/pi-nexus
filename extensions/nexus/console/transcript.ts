/**
 * A Nexus conversation drawn with pi's own message components and tool renderers, the way pi replays a saved
 * session, so a thread reads exactly like a pi transcript. The thread's agent is pi too, so its messages and tool
 * calls have the shapes these components expect.
 */
import {
	AssistantMessageComponent,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	ToolExecutionComponent,
	UserMessageComponent,
	type Theme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Spacer, Text, type Component, type MarkdownTheme, type TUI } from "@earendil-works/pi-tui";
import { contentText } from "../thread.ts";
import { failed, running, shownResult, stepsSummary, type Block, type ToolItem } from "./model.ts";

/** The user's pi display settings that change how a transcript draws. */
export interface Display {
	outputPad: number;
	hideThinkingBlock: boolean;
	markdownTheme: MarkdownTheme;
	editorPaddingX: number;
}

/**
 * The pylon's paths are not on this machine. The renderers only show them, since a call's arguments are never marked
 * complete here: that is what would make pi's edit renderer read the file for a preview diff.
 */
const pylonCwd = "/";

type Cached = { component: Component; sig: string };

export class Transcript {
	private readonly renderers: Record<string, ToolDefinition<any, any, any>>;
	private cache = new Map<string, Cached>();
	/** pi's ctrl+o: tool output expanded, and every fold of steps open. */
	expanded = false;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly display: Display,
	) {
		this.renderers = {
			bash: createBashToolDefinition(pylonCwd),
			edit: createEditToolDefinition(pylonCwd),
			find: createFindToolDefinition(pylonCwd),
			grep: createGrepToolDefinition(pylonCwd),
			ls: createLsToolDefinition(pylonCwd),
			read: createReadToolDefinition(pylonCwd),
			write: createWriteToolDefinition(pylonCwd),
		};
	}

	/**
	 * The components for `blocks`, in pi's spacing. A message or tool whose item has not changed keeps its component,
	 * so its renderer's state and cache survive the next poll.
	 */
	build(blocks: readonly Block[]): Component[] {
		const next = new Map<string, Cached>();
		const out: Component[] = [];
		const keep = (key: string, sig: string, make: () => Component, update?: (c: Component) => Component) => {
			const old = this.cache.get(key);
			let component: Component;
			if (old === undefined) component = make();
			else {
				component = old.component;
				if (old.sig !== sig) component = update ? update(component) : make();
			}
			next.set(key, { component, sig });
			return component;
		};
		for (const block of blocks) {
			switch (block.kind) {
				case "user":
					if (out.length > 0) out.push(new Spacer(1));
					out.push(keep(block.key, block.text, () => new UserMessageComponent(block.text, this.display.markdownTheme, this.display.outputPad)));
					break;
				case "assistant": {
					const make = () =>
						new AssistantMessageComponent(
							block.message as never,
							this.display.hideThinkingBlock,
							this.display.markdownTheme,
							undefined,
							this.display.outputPad,
						);
					const sig = block.streaming ? `streaming:${contentText(block.message.content)}` : "done";
					out.push(
						keep(block.key, sig, make, (c) => {
							(c as AssistantMessageComponent).updateContent(block.message as never, block.streaming);
							return c;
						}),
					);
					break;
				}
				case "tool":
					out.push(this.tool(block, keep));
					break;
				case "steps": {
					const open = this.expanded || block.tools.some((t) => failed(t) || running(t));
					out.push(new Spacer(1), new Text(this.stepsLine(block.tools, open), this.display.outputPad, 0));
					if (open) out.push(...block.tools.map((t) => this.tool(t, keep)));
					break;
				}
			}
		}
		this.cache = next;
		return out;
	}

	private stepsLine(tools: readonly ToolItem[], open: boolean): string {
		const t = this.theme;
		const s = stepsSummary(tools);
		const sep = t.fg("dim", " · ");
		return [
			t.fg("muted", `${open ? "▾" : "▸"} ${s.count} steps`) + sep + t.fg("muted", s.names),
			...(s.failed > 0 ? [sep + t.fg("error", `${s.failed} failed${s.exit === undefined ? "" : `, exit ${s.exit}`}`)] : []),
			...(s.running > 0 ? [sep + t.fg("warning", `${s.running} running`)] : []),
		].join("");
	}

	private tool(tool: ToolItem, keep: (key: string, sig: string, make: () => Component, update?: (c: Component) => Component) => Component): Component {
		const result = tool.result;
		const sig = `${this.expanded}:${result.state}:${result.state === "running" ? result.output : ""}`;
		const apply = (c: ToolExecutionComponent) => {
			c.setExpanded(this.expanded);
			const shown = shownResult(tool);
			if (shown !== undefined) c.updateResult(shown.message as never, shown.partial);
			return c;
		};
		const make = () =>
			apply(new ToolExecutionComponent(tool.call.name, tool.call.id, tool.call.arguments, { outputPad: this.display.outputPad, showImages: false }, this.renderers[tool.call.name], this.tui, pylonCwd));
		// A component cannot drop a result it drew, so a call whose result went away, after a reset, starts afresh.
		return keep(tool.key, sig, make, (c) => (result.state === "none" ? make() : apply(c as ToolExecutionComponent)));
	}
}
