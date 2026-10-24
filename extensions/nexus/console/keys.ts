/**
 * The console's normal-mode keys, as tables. Vim's keys come first and pi's arrow keys still work. A screen reads
 * keys through a `KeyReader` over its table, and the `?` help and the hint line draw from the same table, so what a
 * key does and what the console says it does cannot drift apart.
 */
import { rawKeyHint } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, matchesKey, parseKey, type KeyId } from "@earendil-works/pi-tui";

/** Keys pi names, matched with matchesKey. Anything else in a table is typed text, such as `j`, `G` or `gg`. */
const named = new Set(["up", "down", "left", "right", "enter", "escape", "tab", "home", "end", "pageUp", "pageDown"]);
const isNamed = (key: string) => key.includes("+") || named.has(key);

export interface Binding<C extends string> {
	keys: readonly string[];
	command: C;
	/** What the key does, for the help. */
	help: string;
}

/**
 * The text of a key pi's parser names as one character, or as Shift and a letter, which is how it reads a key sent in
 * another encoding, such as xterm modifyOtherKeys: ESC[27;2;71~ is shift+g, so G.
 */
function parsedPrintable(data: string): string | undefined {
	const id = parseKey(data);
	if (id === undefined) return undefined;
	if ([...id].length === 1) return id;
	const letter = /^shift\+([a-z])$/.exec(id)?.[1];
	return letter?.toUpperCase();
}

/** The text a key types, or undefined for a key that types none, such as an arrow or ctrl+d. */
function typed(data: string): string | undefined {
	const kitty = decodeKittyPrintable(data);
	if (kitty !== undefined) return kitty;
	if ([...data].length === 1) return data.charCodeAt(0) >= 32 && data.charCodeAt(0) !== 127 ? data : undefined;
	return parsedPrintable(data);
}

/**
 * Turns input into the commands of `bindings`. A typed key that starts a longer one, such as the first `g` of `gg`,
 * waits for the next key.
 */
export class KeyReader<C extends string> {
	private pending = "";

	constructor(private readonly bindings: readonly Binding<C>[]) {}

	/** The typed keys waiting for the rest of a sequence, such as `g`. */
	get waiting(): string {
		return this.pending;
	}

	read(data: string): C | undefined {
		const text = typed(data);
		if (text !== undefined) {
			const sequence = this.pending + text;
			const longer = this.bindings.some((b) => b.keys.some((k) => !isNamed(k) && k.length > sequence.length && k.startsWith(sequence)));
			if (longer) {
				this.pending = sequence;
				return undefined;
			}
			this.pending = "";
			const command = this.bindings.find((b) => b.keys.includes(sequence))?.command;
			// A key that ends no sequence counts on its own, so g then G still goes to the end.
			return command === undefined && sequence !== text ? this.read(data) : command;
		}
		this.pending = "";
		return this.bindings.find((b) => b.keys.some((k) => isNamed(k) && matchesKey(data, k as KeyId)))?.command;
	}
}

const shown: Readonly<Record<string, string>> = { up: "↑", down: "↓", left: "←", right: "→", pageUp: "pgup", pageDown: "pgdn", escape: "esc", enter: "enter" };
const keyLabel = (key: string) => shown[key] ?? key;

/** A binding's keys as the help names them, vim's first: `j/↓`. */
const keysLabel = (binding: Binding<string>) => binding.keys.map(keyLabel).join("/");

/** pi's hint for `command`, named by its first key. */
export function hint<C extends string>(bindings: readonly Binding<C>[], command: C, description: string): string {
	return rawKeyHint(keyLabel(bindings.find((b) => b.command === command)!.keys[0]!), description);
}

/** The help: every binding, one per line, its keys in a column. */
export function helpLines<C extends string>(bindings: readonly Binding<C>[]): { keys: string; help: string }[] {
	return bindings.map((b) => ({ keys: keysLabel(b), help: b.help }));
}
