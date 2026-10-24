/** The arguments of `/nexus`, parsed into one command. */
import { harnesses, type Thread } from "./contract.ts";
import { NexusError } from "./thread.ts";

/** Thread actions that map one to one onto a nexus CLI command. */
export const actions = {
	archive: { done: "Archived" },
	unarchive: { done: "Unarchived" },
	delete: { done: "Deleted" },
	retry: { done: "Retried the parked tasks of" },
	"retry-pylon": { done: "Retried the pylon of" },
	abort: { done: "Aborted the run of" },
} as const;
export type Action = keyof typeof actions;

export type NexusCommand =
	| { name: "browse" }
	| { name: "start"; project?: string; title?: string }
	| { name: "list"; project?: string }
	| { name: "new"; project: string; title?: string; message: string }
	| { name: "send"; thread: string; text: string }
	| { name: "open" | "show" | "follow"; thread: string }
	| { name: "unfollow"; thread?: string }
	| { name: "unpublish"; thread: string; port: number }
	| { name: "strip"; on: boolean }
	/** `project` undefined shows the scope, and null is every project. */
	| { name: "scope"; project?: string | null }
	| { name: "add-project"; id: string; repoUrl: string; node: string; branch?: string }
	| { name: "session-open"; thread: string; harness?: string; title?: string }
	/** `session` is a session's ID, which is its pane for a session in one. Without it, it asks which to close. */
	| { name: "session-close"; thread: string; session?: string }
	| { name: "attach"; thread: string }
	| { name: Action; thread: string }
	| { name: "help" };

export const usage = `/nexus                              the working thread over the picker, or the picker
/nexus open <thread>                 the thread as a pi session, to read and message it
/nexus new [project]                 the start form
/nexus list [project]                threads, without deleted ones
/nexus new <project> [--title T] <message>
/nexus send <thread> <text>          queued after the current turn
/nexus show <thread>                 state and conversation tail
/nexus follow <thread>               stream entries until the next turn ends
/nexus unfollow [thread]             stop one follow, or all
/nexus unpublish <thread> <port>     close a port's preview
/nexus archive|unarchive|retry|retry-pylon|abort <thread>
/nexus delete <thread>               asks first
/nexus strip on|off                  the threads that need you, have news or work, above the editor
/nexus project [id|all]              which project's threads show, or the one shown
/nexus project add <id> <repo-url> --node <node> [--branch <branch>]
/nexus session open <thread> [--harness claude-code|pi|shell] [--title T]
/nexus session close <thread> [id]  a session by its pane or ID, or asks which
/nexus session attach <thread>       this terminal on the pylon's sessions, until you detach
A thread is its ID or a unique prefix of it, with or without th-.`;

const names = ["open", "list", "new", "send", "show", "follow", "unfollow", "unpublish", "strip", "project", "session", ...Object.keys(actions), "help"];
const sessionCommands = ["open", "close", "attach"];

interface Token {
	value: string;
	start: number;
	/** The token holds a quote it does not close, so it runs to the end of the input. */
	open?: true;
}

/**
 * `input` split into words as a shell splits them, so a title can hold spaces: at whitespace outside quotes, a quote
 * anywhere in a word quoting up to its close (`--title="two words"`), and a backslash outside single quotes taking the
 * next character as it is. In double quotes only `\"` and `\\` escape. A quote left open makes the last token open.
 */
function lex(input: string): Token[] {
	const tokens: Token[] = [];
	// Set in add, which flow analysis does not follow into.
	let token = null as Token | null;
	let quote: '"' | "'" | null = null;
	const add = (start: number, text: string) => {
		token ??= { value: "", start };
		token.value += text;
	};
	for (let at = 0; at < input.length; at++) {
		const char = input[at]!;
		if (quote) {
			if (char === quote) quote = null;
			else if (char === "\\" && quote === '"' && (input[at + 1] === '"' || input[at + 1] === "\\")) add(at, input[++at]!);
			else add(at, char);
		} else if (/\s/.test(char)) {
			if (token) tokens.push(token);
			token = null;
		} else if (char === '"' || char === "'") {
			quote = char;
			add(at, "");
		} else if (char === "\\" && at + 1 < input.length) {
			add(at, input[at + 1]!);
			at++;
		} else add(at, char);
	}
	if (token) tokens.push(quote ? { ...token, open: true } : token);
	return tokens;
}

/** Everything from `token` on as typed, without the quotes around it when it is one quoted token. */
function rest(input: string, token: Token): string {
	const text = input.slice(token.start).trim();
	const quoted = /^"([^"]*)"$|^'([^']*)'$/.exec(text);
	return quoted ? (quoted[1] ?? quoted[2]!) : text;
}

const invalid = (problem: string) => new NexusError("invalid", `${problem}\n${usage}`);

export function parseCommand(input: string): NexusCommand {
	const tokens = lex(input);
	const [name, ...args] = tokens.map((t) => t.value);
	/** Refuses a quote left open before token `end`, where a message as typed would start. */
	const closedBefore = (end: number) => {
		const open = tokens.findIndex((t) => t.open);
		if (open !== -1 && open < end) throw invalid(`${open === 0 ? "/nexus" : name} has a quote it does not close`);
	};
	// A message as typed can hold a lone apostrophe; anything else, the command name included, closes its quotes.
	closedBefore(name === "new" || name === "send" ? 1 : tokens.length);
	const arg = (i: number, what: string) => {
		const value = args[i];
		if (value === undefined) throw invalid(`${name} needs ${what}`);
		return value;
	};
	const only = (count: number) => {
		if (args.length > count) throw invalid(`${name} takes ${count === 0 ? "no arguments" : count === 1 ? "one argument" : `${count} arguments`}`);
	};
	switch (name) {
		case undefined:
			return { name: "browse" };
		case "list":
			only(1);
			return args[0] === undefined ? { name } : { name, project: args[0] };
		case "new": {
			if (args.length === 0) return { name: "start" };
			const project = args[0]!;
			let at = 2;
			let title: string | undefined;
			if (args[1] === "--title" || args[1] === "-t") {
				title = arg(2, "a title after --title");
				at = 4;
			} else if (args[1]?.startsWith("--title=")) {
				title = args[1].slice("--title=".length);
				at = 3;
			}
			closedBefore(at);
			const first = tokens[at];
			if (first === undefined) return { name: "start", project, ...(title === undefined ? {} : { title }) };
			return { name, project, ...(title === undefined ? {} : { title }), message: rest(input, first) };
		}
		case "send": {
			closedBefore(2);
			const thread = arg(0, "a thread");
			if (tokens[2] === undefined) throw invalid("send needs text");
			return { name, thread, text: rest(input, tokens[2]) };
		}
		case "unfollow":
			only(1);
			return args[0] === undefined ? { name } : { name, thread: args[0] };
		case "unpublish": {
			only(2);
			const thread = arg(0, "a thread");
			const port = Number(arg(1, "a port"));
			if (!Number.isInteger(port) || port < 1 || port > 65535) throw invalid(`unpublish needs a port from 1 to 65535, got ${args[1]}`);
			return { name, thread, port };
		}
		case "strip":
			only(1);
			if (args[0] !== "on" && args[0] !== "off") throw invalid("strip needs on or off");
			return { name, on: args[0] === "on" };
		case "project":
			if (args[0] === "add") return addProject(args.slice(1));
			if (args.length > 1) throw invalid("project takes one argument, or add");
			return args[0] === undefined ? { name: "scope" } : { name: "scope", project: args[0] === "all" ? null : args[0] };
		case "session":
			return session(args);
		case "help":
			return { name };
		case "open":
		case "show":
		case "follow":
			only(1);
			return { name, thread: arg(0, "a thread") };
		default:
			if (!Object.hasOwn(actions, name)) throw invalid(`unknown command ${name}`);
			only(1);
			return { name: name as Action, thread: arg(0, "a thread") };
	}
}

/** `command`'s arguments, and its `allowed` flags, each as `--flag value` or `--flag=value`. */
function flagged<F extends string>(command: string, args: readonly string[], allowed: readonly [F, F]): { positional: string[]; flags: Partial<Record<F, string>> } {
	const positional: string[] = [];
	const flags: Partial<Record<F, string>> = {};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (!arg.startsWith("--")) {
			positional.push(arg);
			continue;
		}
		const [flag, inline] = arg.slice(2).split(/=(.*)/s) as [string, string | undefined];
		if (!allowed.includes(flag as F)) throw invalid(`${command} takes only --${allowed[0]} and --${allowed[1]}, got --${flag}`);
		const value = inline ?? args[++i];
		if (value === undefined || value === "") throw invalid(`${command} needs a ${flag} after --${flag}`);
		flags[flag as F] = value;
	}
	return { positional, flags };
}

/** `project add`'s arguments: an ID and a repo URL, and --node and --branch. */
function addProject(args: readonly string[]): NexusCommand {
	const { positional, flags } = flagged("project add", args, ["node", "branch"]);
	if (positional.length !== 2) throw invalid("project add needs an ID and a repo URL");
	if (flags.node === undefined) throw invalid("project add needs --node <node>");
	const [id, repoUrl] = positional as [string, string];
	return { name: "add-project", id, repoUrl, node: flags.node, ...(flags.branch === undefined ? {} : { branch: flags.branch }) };
}

/** `session open|close|attach` and their arguments. */
function session([command, ...args]: readonly string[]): NexusCommand {
	switch (command) {
		case "open": {
			const { positional, flags } = flagged("session open", args, ["harness", "title"]);
			if (positional.length !== 1) throw invalid("session open needs a thread");
			if (flags.harness !== undefined && !(harnesses as readonly string[]).includes(flags.harness)) {
				throw invalid(`session open needs a harness of ${harnesses.join(", ")}, got ${flags.harness}`);
			}
			return { name: "session-open", thread: positional[0]!, ...flags };
		}
		case "close":
			if (args.length === 0 || args.length > 2) throw invalid("session close needs a thread, and may name a session's pane or ID");
			return { name: "session-close", thread: args[0]!, ...(args[1] === undefined ? {} : { session: args[1] }) };
		case "attach":
			if (args.length !== 1) throw invalid("session attach needs a thread");
			return { name: "attach", thread: args[0]! };
		default:
			throw invalid(command === undefined ? "session needs open, close or attach" : `session has no command ${command}`);
	}
}

const takesThread = new Set(["open", "send", "show", "follow", "unfollow", "unpublish", ...Object.keys(actions)]);

/** Completes `partial` as a thread ID from `threads`, after `before`. */
function threadItems(before: string, partial: string, threads: readonly Thread[]) {
	const items = threads
		.filter((t) => t.id.startsWith(partial) || t.id.startsWith(`th-${partial}`))
		.map((t) => ({ value: `${before} ${t.id}`, label: t.id, description: `${t.status} ${t.project}: ${t.title}` }));
	return items.length > 0 ? items : null;
}

/** Completes the command name, then a thread ID from the threads last listed, or a project they are on. */
export function complete(prefix: string, threads: readonly Thread[]): { value: string; label: string; description?: string }[] | null {
	const space = prefix.indexOf(" ");
	if (space === -1) {
		const items = names.filter((n) => n.startsWith(prefix)).map((n) => ({ value: n, label: n }));
		return items.length > 0 ? items : null;
	}
	const name = prefix.slice(0, space);
	const partial = prefix.slice(space + 1);
	if (name === "session") {
		const [command = "", ...more] = partial.split(" ");
		if (more.length === 1 && sessionCommands.includes(command)) return threadItems(`session ${command}`, more[0]!, threads);
		if (more.length > 0) return null;
		const items = sessionCommands.filter((c) => c.startsWith(command)).map((c) => ({ value: `session ${c}`, label: c }));
		return items.length > 0 ? items : null;
	}
	if (partial.includes(" ")) return null;
	if (name === "project") {
		const items = ["all", "add", ...new Set(threads.map((t) => t.project))].filter((p) => p.startsWith(partial)).map((p) => ({ value: `project ${p}`, label: p }));
		return items.length > 0 ? items : null;
	}
	return takesThread.has(name) ? threadItems(name, partial, threads) : null;
}
