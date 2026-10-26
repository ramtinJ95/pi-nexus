/**
 * The thread view's Pylon and Previews, as the dashboard's inspector: Pylon holds its state, outputs and Sessions;
 * Previews holds the links and the ports that listen with no preview. Each port shows once: in the Previews
 * section while it has one, in the Ports section otherwise.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { hyperlink, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { NodeSummary, Session, ThreadDetail, ThreadStatus } from "../contract.ts";
import {
	ago,
	attachCommand,
	attachHint,
	badge,
	desiredTone,
	harnessLabel,
	linkedPort,
	noChange,
	portRows,
	previewLook,
	sessionLook,
	sessionName,
	shownOutputs,
	toneColor,
	type PortChange,
	type SessionChanges,
	type Tone,
} from "./model.ts";

type Color = "error" | "dim" | "muted";

function writer(theme: Theme, width: number) {
	const t = theme;
	const lines: string[] = [];
	return {
		t,
		lines,
		heading(text: string, count?: number) {
			if (lines.length > 0) lines.push("");
			lines.push(` ${t.fg("accent", t.bold(text))}${count === undefined ? "" : t.fg("dim", ` ${count}`)}`);
		},
		dot: (tone: Tone) => t.fg(toneColor[tone], "●"),
		wrapped(text: string, color: Color, indent = 3) {
			for (const line of wrapTextWithAnsi(text, Math.max(10, width - indent - 1))) lines.push(`${" ".repeat(indent)}${t.fg(color, line)}`);
		},
		done: () => lines.map((line) => truncateToWidth(line, width)),
	};
}

const loading = (t: Theme) => [` ${t.fg("muted", "Loading the pylon's details...")}`];

export function detailLines(theme: Theme, detail: ThreadDetail | undefined, nodes: readonly NodeSummary[] | Error | undefined, shown: Pick<ThreadDetail, "previews">, now: number, width: number): string[] {
	if (detail === undefined) return loading(theme);
	const w = writer(theme, width);
	const { t, lines } = w;
	const state = (label: string, tone: Tone) => `${w.dot(tone)} ${label}`;
	const kv = (key: string, value: string) => lines.push(`   ${t.fg("muted", key.padEnd(10))} ${value}`);
	const { thread, pylon } = detail;
	const node = Array.isArray(nodes) ? nodes.find((n) => n.name === pylon.node) : undefined;
	const offline = node?.state === "offline";

	w.heading("Pylon");
	kv("Desired", state(detail.desired, desiredTone[detail.desired]));
	kv("Observed", state(...badge(pylon.actualState)));
	kv("Node", `${pylon.node}${offline ? t.fg("warning", " offline") : ""}`);
	kv("Last seen", pylon.observedAt === null ? "never" : `${ago(Date.parse(pylon.observedAt), now)}${offline ? " (stale)" : ""}`);
	kv("Human", ago(thread.lastHumanActivityAt, now));
	kv("Agent", thread.agentTurnRunning ? "turn running" : ago(thread.lastAgentActivityAt, now));
	lines.push(`   ${t.fg("dim", pylon.id)}`);
	if (pylon.failed !== null) w.wrapped(`The planner gave up: ${pylon.failed}`, "error");

	const outputs = shownOutputs({ ...detail, previews: shown.previews });
	w.heading("Outputs", outputs.length);
	if (outputs.length === 0) lines.push(`   ${t.fg("dim", "No outputs yet.")}`);
	for (const o of outputs) lines.push(`   ${t.fg("muted", o.kind.padEnd(8))} ${o.ref}`);
	const review = detail.review;
	if (review) {
		w.wrapped(`Nexus review ${review.id}: ${review.phase.kind}, round ${review.rounds.length} of ${review.maxRounds}, by ${review.reviewer} on ${review.models.reviewer}${review.land === null ? "" : ", landing when approved"}`, "muted");
		if (review.phase.kind === "needs-person") for (const reason of review.phase.reasons ?? []) w.wrapped(`Needs you: ${reason}`, "error");
	}

	w.heading("Attach from a shell in the pylon");
	lines.push(`   ${t.fg("mdCode", detail.attach)}`);
	return w.done();
}

/** What the selected session's keys do. Attaching wakes a paused pylon, but not an archived thread's. */
function sessionHint(s: Session, thread: ThreadStatus): string {
	if (s.state === "running") return "enter or /attach attaches this terminal, x closes the session";
	if (s.state === "failed") return "enter or /attach attaches this terminal, x closes the session so that no wake tries it again";
	if (thread === "archived") return "/unarchive brings it back, and it can be closed once it runs";
	return "enter or /attach wakes the pylon and attaches this terminal. It can be closed once it runs";
}

/**
 * The sessions, one row each in `sessions`' order, the `selected` one marked and named in the hints, then the opens
 * under way and how to attach from this Mac. `rows` holds each row's first and last line, as portLines does.
 */
export function sessionLines(
	theme: Theme,
	detail: ThreadDetail | undefined,
	/** The sessions with what the person confirmed since the details were read. */
	sessions: readonly Session[],
	changes: SessionChanges,
	selected: number,
	width: number,
	/** The CLI binary the attach command names. */
	cli: string,
): { lines: string[]; rows: [first: number, last: number][] } {
	if (detail === undefined) return { lines: loading(theme), rows: [] };
	const w = writer(theme, width);
	const { t, lines } = w;
	const rows: [number, number][] = [];
	const mark = (i: number) => (i === selected ? ` ${t.fg("accent", "→")} ` : "   ");

	w.heading("Sessions", sessions.length);
	if (sessions.length === 0 && changes.opening.length === 0) lines.push(`   ${t.fg("dim", "No sessions. n opens one: Claude Code, pi or a shell.")}`);
	const thread = detail.thread.status;
	const harnessWidth = Math.max(0, ...sessions.map((s) => visibleWidth(harnessLabel[s.harness] ?? s.harness)));
	const titleWidth = Math.max(0, ...sessions.map((s) => visibleWidth(s.title ?? "")));
	const pad = (text: string, columns: number) => text + " ".repeat(columns - visibleWidth(text));
	for (const [i, s] of sessions.entries()) {
		const first = lines.length;
		const closing = changes.closing.has(s.id);
		const [status, tone]: [string, Tone] = closing ? ["closing...", "busy"] : sessionLook(s, thread);
		const harness = pad(harnessLabel[s.harness] ?? s.harness, harnessWidth);
		const title = titleWidth > 0 ? `${t.bold(pad(s.title ?? "", titleWidth))}  ` : "";
		const id = s.harnessSessionId ? t.fg("dim", `  session ${s.harnessSessionId}`) : "";
		// A failed session in no pane shows the ID that closes it.
		lines.push(`${mark(i)}${harness}  ${title}${w.dot(tone)} ${status}  ${t.fg("dim", s.herdrPane ?? s.id)}${id}`);
		// The selected row's message shows whole, such as the pane's screen when its agent did not start.
		if (s.state === "failed" && !closing) w.wrapped(i === selected ? s.message : s.message.split("\n")[0]!, "error", 5);
		if (i === selected && !closing) lines.push(`     ${t.fg("dim", sessionHint(s, thread))}`);
		rows[i] = [first, lines.length - 1];
	}
	for (const o of changes.opening) {
		lines.push(`   ${w.dot("busy")} ${t.fg("muted", `Opening ${sessionName(o.harness, o.title)}...`)}`);
		w.wrapped("Waking the pylon if it is paused, then starting the agent, which can take a minute.", "dim", 5);
	}

	w.heading("Attach from this Mac");
	lines.push(`   ${t.fg("mdCode", attachCommand(cli, detail.thread.id))}`);
	w.wrapped("enter runs it here, and y copies it. Each session is a workspace in the pylon's Herdr: pick one there, and detach from Herdr to come back.", "dim");
	w.wrapped(attachHint, "dim");
	return { lines: w.done(), rows };
}

/**
 * The previews and ports, one row each in portRows' order, the `selected` one marked as the picker marks its row. A
 * row's hint names Enter when it is selected. `rows` holds each row's first and last line, so the view can keep
 * the selected one in sight.
 */
export function portLines(
	theme: Theme,
	detail: ThreadDetail | undefined,
	/** The previews and ports with what the person confirmed since the details were read. */
	shown: Pick<ThreadDetail, "previews" | "ports">,
	changes: ReadonlyMap<number, PortChange>,
	selected: number,
	width: number,
): { lines: string[]; rows: [first: number, last: number][] } {
	if (detail === undefined) return { lines: loading(theme), rows: [] };
	const w = writer(theme, width);
	const { t, lines } = w;
	const rows: [number, number][] = [];
	const all = portRows(shown);
	const mark = (i: number) => (i === selected ? ` ${t.fg("accent", "→")} ` : "   ");
	const press = (key: string) => (i: number, typed: string) => (i === selected ? `${key} or ${typed}` : typed);
	const enter = press("enter");
	const x = press("x");
	const row = (i: number, draw: () => void) => {
		const first = lines.length;
		draw();
		rows[i] = [first, lines.length - 1];
	};
	// A link opens on a click in pi's full screen and in most terminals, and y or /copy puts it on the clipboard.
	const link = (url: string) => hyperlink(t.fg("mdLink", url), url);
	const canRun = detail.thread.status === "active" || detail.thread.status === "idle";

	const previews = all.flatMap((r, i) => (r.kind === "preview" ? [{ ...r, i }] : []));
	w.heading("Previews", previews.length);
	if (previews.length === 0) lines.push(`   ${t.fg("dim", "No previews.")}`);
	for (const { preview: p, port, i } of previews) {
		row(i, () => {
			const look = previewLook(detail, p);
			// Only a port's own preview can be unpublished; the CLI refuses a service's.
			const linked = linkedPort(p.service);
			const change = port === undefined ? noChange : (changes.get(port) ?? noChange);
			const closing = change.pending === "close";
			const named = port !== undefined && linked === undefined ? t.fg("muted", `  port ${port}`) : "";
			const label = closing ? "closing..." : look.label;
			const tone = closing ? "busy" : look.tone;
			lines.push(`${mark(i)}${w.dot(tone)} ${p.service}${label === null ? "" : t.fg(tone === "bad" ? "error" : "muted", ` ${label}`)}${named}`);
			lines.push(`     ${look.linked ? link(p.url) : t.fg("dim", p.url)}`);
			if (look.hint !== null) w.wrapped(look.hint, "dim", 5);
			if (closing) lines.push(`     ${t.fg("muted", "Unpublishing it. A paused pylon wakes first, which can take a while.")}`);
			else if (change.failure?.action === "close") {
				lines.push(`     ${t.fg("muted", linked === undefined ? "did not close." : `did not close. ${x(i, `/unpublish ${port}`)} tries again`)}`);
				w.wrapped(change.failure.message, "error", 5);
			} else if (linked !== undefined && canRun && change.pending === null) lines.push(`     ${t.fg("dim", `${x(i, `/unpublish ${linked}`)} closes it`)}`);
		});
	}
	if (previews.some((p) => previewLook(detail, p.preview).linked)) {
		lines.push(`     ${t.fg("dim", "Click a link to open it, or copy it with y or /copy <port or service>.")}`);
	}

	const ports = shown.ports;
	const unpublished = all.flatMap((r, i) => (r.kind === "port" ? [{ port: r.port, i }] : []));
	w.heading("Ports", ports === null ? 0 : unpublished.length);
	if (ports === null) lines.push(`   ${t.fg("dim", "The pylon's ports could not be read.")}`);
	else if (unpublished.length === 0) {
		if (detail.pylon.actualState !== "running") lines.push(`   ${t.fg("dim", "Ports show while the pylon runs.")}`);
		else w.wrapped(`${ports.length === 0 ? "Nothing listens yet." : "Every port that listens is under Previews."}`, "dim");
	}
	for (const { port: p, i } of unpublished) {
		row(i, () => {
			const port = t.bold(String(p.port));
			if (p.service !== null) {
				lines.push(`${mark(i)}${w.dot("muted")} ${port}  ${t.fg("muted", `${p.service}, a service with no preview`)}`);
				return;
			}
			const change = changes.get(p.port) ?? noChange;
			if (change.pending === "open") lines.push(`${mark(i)}${w.dot("busy")} ${port}  ${t.fg("muted", "opening: publishing it and waiting for the node to serve its URL...")}`);
			else if (change.failure?.action === "open") {
				lines.push(`${mark(i)}${w.dot("bad")} ${port}  ${t.fg("muted", `did not open. ${enter(i, `/open ${p.port}`)} tries again`)}`);
				w.wrapped(change.failure.message, "error");
			} else lines.push(`${mark(i)}${w.dot("muted")} ${port}  ${t.fg("muted", `no preview yet. ${enter(i, `/open ${p.port}`)} publishes one`)}`);
		});
	}
	return { lines: w.done(), rows };
}
