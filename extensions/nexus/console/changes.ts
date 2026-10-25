/** Checkout reads are human activity: no timer, and no implicit wake. */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ChangedFile, Changes, Diff } from "../contract.ts";

export const statusLetter: Readonly<Record<ChangedFile["status"], string>> = { added: "A", modified: "M", deleted: "D", renamed: "R", copied: "C", typechange: "T" };
export type TreeRow = { path: string; name: string; depth: number } & ({ kind: "folder"; closed: boolean } | { kind: "file"; file: ChangedFile });

export function treeRows(files: readonly ChangedFile[], closed: ReadonlySet<string>): TreeRow[] {
	interface Dir { dirs: Map<string, Dir>; files: ChangedFile[] }
	const root: Dir = { dirs: new Map(), files: [] };
	for (const file of files) {
		let dir = root;
		for (const part of file.path.split("/").slice(0, -1)) {
			if (!dir.dirs.has(part)) dir.dirs.set(part, { dirs: new Map(), files: [] });
			dir = dir.dirs.get(part)!;
		}
		dir.files.push(file);
	}
	const rows: TreeRow[] = [];
	function branch(dir: Dir, parent: string, depth: number) {
		for (let [name, child] of [...dir.dirs].sort(([a], [b]) => a.localeCompare(b))) {
			while (!child.files.length && child.dirs.size === 1) {
				const [part, inner] = [...child.dirs][0]!;
				name += `/${part}`;
				child = inner;
			}
			const path = parent + name;
			rows.push({ kind: "folder", path, name, depth, closed: closed.has(path) });
			if (!closed.has(path)) branch(child, `${path}/`, depth + 1);
		}
		for (const file of [...dir.files].sort((a, b) => a.path.localeCompare(b.path))) rows.push({ kind: "file", file, path: file.path, name: file.path.split("/").at(-1)!, depth });
	}
	branch(root, "", 0);
	return rows;
}

export interface DiffRow { kind: "hunk" | "add" | "remove" | "context"; line: number | null; text: string }
export const maxDiffRows = 20_000;
const metaLine = /^(old mode|new mode|new file mode|deleted file mode|similarity index|rename from|rename to|copy from|copy to) /;
export function parseDiff(text: string): { rows: DiffRow[]; meta: string[]; truncated: boolean; binary: boolean } {
	const rows: DiffRow[] = [], meta: string[] = [];
	let next = 0, inHunk = false, truncated = false, binary = false;
	for (const line of text.split("\n")) {
		if (line.startsWith("diff --git ")) { inHunk = false; continue; }
		if (/^(Binary files .* differ|GIT binary patch)/.test(line)) binary = true;
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
		let row: DiffRow | undefined;
		if (hunk) {
			next = Number(hunk[1]); inHunk = true;
			row = { kind: "hunk", line: null, text: hunk[2]!.trim() };
		} else if (!inHunk) {
			if (metaLine.test(line)) meta.push(line);
		} else if (/^[ +\-]/.test(line)) {
			const kind = line[0] === "+" ? "add" : line[0] === "-" ? "remove" : "context";
			row = { kind, line: kind === "remove" ? null : next++, text: line.slice(1) };
		}
		if (row) {
			if (rows.length === maxDiffRows) { truncated = true; break; }
			rows.push(row);
		}
	}
	return { rows, meta, truncated, binary };
}

export interface CheckoutFacts { status: string; pylon: string; working: boolean; agentAt: number }
export const canRead = (f: CheckoutFacts | undefined) => f?.pylon === "running" && (f.status === "active" || f.status === "idle");
export interface CheckoutActions {
	changes(uncommitted: boolean, signal: AbortSignal): Promise<Changes>;
	diff(paths: readonly string[], uncommitted: boolean, signal: AbortSignal): Promise<Diff>;
	persist(uncommitted: boolean): void;
}

/** Serializes reads, coalesces requests, and drops replies for a superseded base or file. */
export class Checkout {
	changes: Changes | undefined;
	diff: Diff | undefined;
	file: ChangedFile | undefined;
	facts: CheckoutFacts | undefined;
	uncommitted: boolean;
	error: string | undefined;
	busy = false;
	wanted = false;
	readonly closed = new Set<string>();
	private visited = false;
	private pendingChanges = false;
	private pendingDiff = false;
	private revision = 0;
	private baseRevision = 0;
	private readonly stop = new AbortController();
	constructor(private readonly actions: CheckoutActions, uncommitted: boolean, private readonly redraw: () => void) { this.uncommitted = uncommitted; }
	get rows(): TreeRow[] { return treeRows(this.changes?.files ?? [], this.closed); }
	get canWake(): boolean { return this.facts !== undefined && ["active", "idle"].includes(this.facts.status) && !canRead(this.facts); }
	show(): void {
		if (this.visited) return;
		this.visited = true;
		this.refresh();
	}
	update(now: CheckoutFacts): void {
		const before = this.facts;
		this.facts = now;
		if (!this.visited) return;
		const ended = before && !now.working && (before.working || now.agentAt !== before.agentAt);
		const started = now.pylon === "running" && before?.pylon !== "running";
		if (started && this.wanted && !this.busy) {
			this.wanted = false;
			void this.drain();
			return;
		}
		if (canRead(now) && (ended || (started && (this.wanted || this.changes === undefined)))) {
			// The thread visit can wake the pylon independently. Its first checkout read waits for running.
			// A wake read already waits for running inside the CLI.
			if (!(this.wanted && this.busy)) this.refresh();
		}
	}
	toggle(): void {
		this.uncommitted = !this.uncommitted;
		this.revision++;
		this.baseRevision++;
		this.changes = undefined; this.diff = undefined;
		this.refresh();
		try { this.actions.persist(this.uncommitted); }
		catch (err) { this.error = `The choice lasts for this session only: ${String(err)}`; }
		this.redraw();
	}
	refresh(wake = false): void {
		if (this.stop.signal.aborted) return;
		if (wake && this.canWake) this.wanted = true;
		this.pendingChanges = true;
		this.pendingDiff = this.file !== undefined;
		void this.drain();
	}
	open(file: ChangedFile): void {
		this.file = file; this.diff = undefined; this.error = undefined;
		this.revision++;
		this.pendingDiff = true;
		void this.drain();
	}
	back(): void { this.file = undefined; this.diff = undefined; this.pendingDiff = false; this.revision++; }
	private async drain(): Promise<void> {
		if (this.busy || this.stop.signal.aborted) return;
		if (!this.facts || !["active", "idle"].includes(this.facts.status) || (!canRead(this.facts) && !this.wanted)) { this.redraw(); return; }
		const changes = this.pendingChanges;
		const file = this.file;
		if (!changes && (!this.pendingDiff || !file)) return;
		if (changes) this.pendingChanges = false; else this.pendingDiff = false;
		const revision = this.revision, baseRevision = this.baseRevision, base = this.uncommitted;
		this.busy = true; this.error = undefined; this.redraw();
		try {
			if (changes) {
				const reply = await this.actions.changes(base, this.stop.signal);
				if (baseRevision === this.baseRevision && !this.stop.signal.aborted) {
					this.changes = reply;
					if (this.file) this.file = reply.files.find((f) => f.path === this.file!.path) ?? this.file;
				}
			} else if (file) {
				const reply = await this.actions.diff([file.path, ...(file.oldPath === null ? [] : [file.oldPath])], base, this.stop.signal);
				if (revision === this.revision && !this.stop.signal.aborted) this.diff = reply;
			}
			if (canRead(this.facts)) this.wanted = false;
		} catch (err) {
			if (baseRevision === this.baseRevision && (changes || revision === this.revision) && !this.stop.signal.aborted) {
				this.error = `${err instanceof Error ? err.message : String(err)}${base ? "" : " · c shows the uncommitted changes."}`;
				this.pendingDiff = false;
			}
			this.wanted = false;
		} finally {
			this.busy = false;
			if (!this.stop.signal.aborted) { this.redraw(); void this.drain(); }
		}
	}
	note(): string | undefined {
		if (this.facts?.status === "deleted") return "The thread is deleted, so its checkout is gone.";
		if (this.facts?.status === "archived") return "An archived thread's pylon stays paused, so its changes can't be read. Unarchive the thread to read them.";
		if (!this.facts) return "Waiting for the pylon's state…";
		if (!canRead(this.facts)) return this.wanted
			? "Waking the pylon. Its changes show once it runs."
			: `The pylon is ${this.facts.pylon}. Reading its changes wakes it. Enter or r wakes it and reads.`;
		return undefined;
	}
	dispose(): void { this.stop.abort(); }
}

const counts = (t: Theme, additions: number | null, deletions: number | null) => additions === null ? t.fg("dim", "binary") : `${t.fg("toolDiffAdded", `+${additions}`)} ${t.fg("toolDiffRemoved", `−${deletions}`)}`;
const statusBadge = (t: Theme, status: ChangedFile["status"]) => t.fg(status === "added" ? "toolDiffAdded" : status === "deleted" ? "toolDiffRemoved" : status === "modified" || status === "renamed" ? "accent" : "dim", statusLetter[status]);
const rightAligned = (left: string, right: string, width: number) => {
	const shown = truncateToWidth(left, Math.max(1, width - visibleWidth(right) - 2));
	return shown + " ".repeat(Math.max(1, width - visibleWidth(shown) - visibleWidth(right))) + right;
};

export function changesLines(t: Theme, checkout: Checkout, selected: number, width: number): { lines: string[]; rows: { start: number; end: number }[] } {
	const lines: string[] = [], rows: { start: number; end: number }[] = [];
	const note = checkout.note();
	if (note) lines.push(...wrapTextWithAnsi(note, Math.max(1, width - 2)).map((l) => ` ${t.fg("muted", l)}`));
	if (checkout.busy) lines.push(t.fg("dim", checkout.wanted ? " Waking the pylon…" : " Reading the changes…"));
	if (checkout.error) lines.push(...wrapTextWithAnsi(checkout.error, Math.max(1, width - 2)).map((l) => ` ${t.fg("error", l)}`));
	if (note && !checkout.busy) return { lines, rows };
	const { changes, file, diff } = checkout;
	if (file) {
		lines.push(rightAligned(` ${statusBadge(t, file.status)} ${file.path} ${t.fg("dim", checkout.uncommitted ? "vs last commit" : "vs boot")}`, counts(t, file.additions, file.deletions), width), "");
		if (diff) {
			const parsed = parseDiff(diff.diff);
			lines.push(...parsed.meta.map((m) => ` ${t.fg("dim", m)}`));
			for (const row of parsed.rows) {
				const text = row.text.replaceAll("\t", "    ");
				lines.push(t.fg(row.kind === "add" ? "toolDiffAdded" : row.kind === "remove" ? "toolDiffRemoved" : row.kind === "hunk" ? "dim" : "toolDiffContext", row.kind === "hunk" ? `    ⋯ ${text}` : `${String(row.line ?? "").padStart(5)} ${row.kind === "add" ? "+" : row.kind === "remove" ? "−" : " "} ${text}`));
			}
			if (!parsed.rows.length) lines.push(t.fg("dim", parsed.binary || (file.additions === null && diff.diff !== "") ? " The file is binary, so there is no diff to show." : parsed.meta.length ? " No lines changed." : " The file has no changes now."));
			if (parsed.truncated || diff.truncated) lines.push(t.fg("dim", " The diff is cut short here, because the whole of it is too long to show."));
		}
	} else if (changes) {
		const { files, base } = changes;
		const commit = base.commit?.slice(0, 7) ?? (base.kind === "head" ? "no commit yet" : "an empty repository");
		lines.push(` ${files.length} ${files.length === 1 ? "file" : "files"} · ${counts(t, files.reduce((n, f) => n + (f.additions ?? 0), 0), files.reduce((n, f) => n + (f.deletions ?? 0), 0))} ${t.fg("dim", `since ${base.kind === "head" ? "the last commit" : "the pylon booted"}, ${commit}`)}`, "");
		if (!files.length) lines.push(t.fg("dim", checkout.uncommitted ? " No uncommitted changes." : " Nothing has changed since the pylon booted."));
		checkout.rows.forEach((row, i) => {
			const prefix = `${i === selected ? t.fg("accent", "→") : " "} ${"  ".repeat(row.depth)}`;
			const start = lines.length;
			if (row.kind === "folder") lines.push(`${prefix}${row.closed ? "▸" : "▾"} ${row.name}`);
			else {
				const old = row.file.oldPath && width > 80 ? t.fg("dim", ` ← ${row.file.oldPath}`) : "";
				lines.push(rightAligned(`${prefix}${statusBadge(t, row.file.status)} ${row.name}${old}`, counts(t, row.file.additions, row.file.deletions), width));
			}
			rows.push({ start, end: start });
		});
		if (changes.truncated) lines.push(t.fg("dim", ` Showing the first ${files.length} files.`));
	}
	return { lines: lines.map((l) => truncateToWidth(l, width)), rows };
}
