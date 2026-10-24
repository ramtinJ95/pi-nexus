/** The arguments of `/nexus`, parsed into one command. */
import type { Thread } from "./contract.ts";
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
A thread is its ID or a unique prefix of it, with or without th-.`;

const names = ["open", "list", "new", "send", "show", "follow", "unfollow", "unpublish", "strip", ...Object.keys(actions), "help"];

interface Token {
	value: string;
	start: number;
}

function lex(input: string): Token[] {
	return [...input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => ({ value: m[1] ?? m[2] ?? m[3]!, start: m.index }));
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
			const first = tokens[at];
			if (first === undefined) return { name: "start", project, ...(title === undefined ? {} : { title }) };
			return { name, project, ...(title === undefined ? {} : { title }), message: rest(input, first) };
		}
		case "send": {
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

const takesThread = new Set(["open", "send", "show", "follow", "unfollow", "unpublish", ...Object.keys(actions)]);

/** Completes the command name, then a thread ID from the threads last listed. */
export function complete(prefix: string, threads: readonly Thread[]): { value: string; label: string; description?: string }[] | null {
	const space = prefix.indexOf(" ");
	if (space === -1) {
		const items = names.filter((n) => n.startsWith(prefix)).map((n) => ({ value: n, label: n }));
		return items.length > 0 ? items : null;
	}
	const name = prefix.slice(0, space);
	const partial = prefix.slice(space + 1);
	if (!takesThread.has(name) || partial.includes(" ")) return null;
	const items = threads
		.filter((t) => t.id.startsWith(partial) || t.id.startsWith(`th-${partial}`))
		.map((t) => ({ value: `${name} ${t.id}`, label: t.id, description: `${t.status} ${t.project}: ${t.title}` }));
	return items.length > 0 ? items : null;
}
