/**
 * Rewrites a `tmux capture-pane -e` capture so that freeze draws its colours as the terminal did:
 *
 * - tmux writes a colour only where it changes, so a line that starts inside the previous line's background carries
 *   none, and freeze, which draws each line afresh, drops that background up to the line's first colour change;
 * - freeze ignores the codes that end one attribute, such as 39 and 49 for the default colours, so a background or a
 *   colour runs on past its end.
 *
 * So every line starts with the active colours, and every colour change becomes a full reset followed by all the
 * attributes still active.
 *
 * Usage: bun test/demo/carry-sgr.ts < capture.ansi > capture.carried
 */
const sgr = /\x1b\[([0-9;:]*)m/g;

interface Style {
	fg?: string;
	bg?: string;
	flags: Set<number>;
}

/** The parameters after 38 or 48 that make one colour: `5;n` or `2;r;g;b`. */
function colour(params: number[], i: number): [string, number] {
	if (params[i + 1] === 5) return [params.slice(i, i + 3).join(";"), i + 3];
	if (params[i + 1] === 2) return [params.slice(i, i + 5).join(";"), i + 5];
	return [String(params[i]), i + 1];
}

/** Which flags each code turns off. */
const offs: Record<number, number[]> = { 22: [1, 2], 23: [3], 24: [4], 25: [5], 27: [7], 28: [8], 29: [9] };

function apply(style: Style, raw: string): void {
	const params = raw === "" ? [0] : raw.split(/[;:]/).map((p) => (p === "" ? 0 : Number(p)));
	let i = 0;
	while (i < params.length) {
		const p = params[i]!;
		if (p === 38 || p === 48) {
			const [value, next] = colour(params, i);
			if (p === 38) style.fg = value;
			else style.bg = value;
			i = next;
			continue;
		}
		if (p === 0) {
			style.fg = style.bg = undefined;
			style.flags.clear();
		} else if (p === 39) style.fg = undefined;
		else if (p === 49) style.bg = undefined;
		else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) style.fg = String(p);
		else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) style.bg = String(p);
		else if (offs[p]) for (const off of offs[p]!) style.flags.delete(off);
		else style.flags.add(p);
		i++;
	}
}

const full = (style: Style) => `\x1b[${["0", ...[...style.flags].sort((a, b) => a - b).map(String), ...(style.fg ? [style.fg] : []), ...(style.bg ? [style.bg] : [])].join(";")}m`;

const style: Style = { flags: new Set() };
// The capture ends with a newline, which leaves no line after it to colour.
const lines = (await Bun.stdin.text())
	.replace(/\n$/, "")
	.split("\n")
	.map((line) => full(style) + line.replace(sgr, (_, params: string) => (apply(style, params), full(style))));
process.stdout.write(`${lines.join("\n")}\n`);
