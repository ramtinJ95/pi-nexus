/**
 * The thread view's inspector, as the dashboard's: the pylon, its previews as links, the ports that listen with no
 * preview, the outputs and the sessions. Each port shows once: under Previews while it has one, under Ports otherwise.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { hyperlink, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { NodeSummary, ThreadDetail } from "../contract.ts";
import { ago, badge, desiredTone, harnessLabel, linkedPort, noChange, previewLook, sessionTone, shownOutputs, toneColor, unreachableHint, type PortChange, type Tone } from "./model.ts";

export function inspectorLines(
	theme: Theme,
	detail: ThreadDetail | undefined,
	nodes: readonly NodeSummary[] | Error | undefined,
	/** The previews and ports with what the person confirmed since the details were read. */
	shown: Pick<ThreadDetail, "previews" | "ports"> | undefined,
	changes: ReadonlyMap<number, PortChange>,
	now: number,
	width: number,
): string[] {
	const t = theme;
	const lines: string[] = [];
	const heading = (text: string, count?: number) => {
		if (lines.length > 0) lines.push("");
		lines.push(` ${t.fg("accent", t.bold(text))}${count === undefined ? "" : t.fg("dim", ` ${count}`)}`);
	};
	const dot = (tone: Tone) => t.fg(toneColor[tone], "●");
	const state = (label: string, tone: Tone) => `${dot(tone)} ${label}`;
	const kv = (key: string, value: string) => lines.push(`   ${t.fg("muted", key.padEnd(10))} ${value}`);
	const wrapped = (text: string, color: "error" | "dim" | "muted", indent = 3) => {
		for (const line of wrapTextWithAnsi(text, Math.max(10, width - indent - 1))) lines.push(`${" ".repeat(indent)}${t.fg(color, line)}`);
	};

	if (detail === undefined || shown === undefined) {
		lines.push(` ${t.fg("muted", "Loading the pylon's details...")}`);
		return lines;
	}
	const { thread, pylon } = detail;
	const node = Array.isArray(nodes) ? nodes.find((n) => n.name === pylon.node) : undefined;
	const offline = node?.state === "offline";

	heading("Pylon");
	kv("Desired", state(detail.desired, desiredTone[detail.desired]));
	kv("Observed", state(...badge(pylon.actualState)));
	kv("Node", `${pylon.node}${offline ? t.fg("warning", " offline") : ""}`);
	kv("Last seen", pylon.observedAt === null ? "never" : `${ago(Date.parse(pylon.observedAt), now)}${offline ? " (stale)" : ""}`);
	kv("Human", ago(thread.lastHumanActivityAt, now));
	kv("Agent", thread.agentTurnRunning ? "turn running" : ago(thread.lastAgentActivityAt, now));
	lines.push(`   ${t.fg("dim", pylon.id)}`);
	if (pylon.failed !== null) wrapped(`The planner gave up: ${pylon.failed}`, "error");
	// A link opens on a click in pi's full screen and in most terminals, and /copy puts it on the clipboard.
	const link = (url: string) => hyperlink(t.fg("mdLink", url), url);
	const copyHint = () => lines.push(`     ${t.fg("dim", "Click a link to open it, or /copy <port or service> to copy it.")}`);

	const { previews, ports } = shown;
	const canRun = thread.status === "active" || thread.status === "idle";
	heading("Previews", previews.length);
	if (previews.length === 0) lines.push(`   ${t.fg("dim", "No previews.")}`);
	const portOf = new Map((ports ?? []).flatMap((p) => (p.preview ? [[p.preview.service, p.port] as const] : [])));
	for (const p of previews) {
		const look = previewLook(detail, p.ready);
		// Only a port's own preview can be unpublished; the CLI refuses a service's.
		const linked = linkedPort(p.service);
		const port = linked ?? portOf.get(p.service);
		const change = port === undefined ? noChange : (changes.get(port) ?? noChange);
		const closing = change.pending === "close";
		const named = port !== undefined && linked === undefined ? t.fg("muted", `  port ${port}`) : "";
		const label = closing ? "closing..." : look.label;
		lines.push(`   ${dot(closing ? "busy" : look.tone)} ${p.service}${label === null ? "" : t.fg("muted", ` ${label}`)}${named}`);
		lines.push(`     ${look.linked ? link(p.url) : t.fg("dim", p.url)}`);
		if (look.hint !== null) lines.push(`     ${t.fg("dim", look.hint)}`);
		if (closing) lines.push(`     ${t.fg("muted", "Unpublishing it. A paused pylon wakes first, which can take a while.")}`);
		else if (change.failure?.action === "close") {
			lines.push(`     ${t.fg("muted", linked === undefined ? "did not close." : `did not close. /unpublish ${port} tries again`)}`);
			wrapped(change.failure.message, "error", 5);
		} else if (linked !== undefined && canRun && change.pending === null) lines.push(`     ${t.fg("dim", `/unpublish ${linked} closes it`)}`);
	}
	if (previews.some((p) => previewLook(detail, p.ready).linked)) copyHint();

	const unpublished = ports?.filter((p) => p.preview === null) ?? null;
	heading("Ports", unpublished?.length ?? 0);
	if (unpublished === null) lines.push(`   ${t.fg("dim", "The pylon's ports could not be read.")}`);
	else if (unpublished.length === 0) {
		if (pylon.actualState !== "running") lines.push(`   ${t.fg("dim", "Ports show while the pylon runs.")}`);
		else wrapped(`${ports!.length === 0 ? "Nothing listens yet." : "Every port that listens is under Previews."} ${unreachableHint}`, "dim");
	}
	for (const p of unpublished ?? []) {
		const port = t.bold(String(p.port));
		if (p.service !== null) {
			lines.push(`   ${dot("muted")} ${port}  ${t.fg("muted", `${p.service}, a service with no preview`)}`);
			continue;
		}
		const change = changes.get(p.port) ?? noChange;
		if (change.pending === "open") lines.push(`   ${dot("busy")} ${port}  ${t.fg("muted", "opening: publishing it and waiting for the node to serve its URL...")}`);
		else if (change.failure?.action === "open") {
			lines.push(`   ${dot("bad")} ${port}  ${t.fg("muted", `did not open. /open ${p.port} tries again`)}`);
			wrapped(change.failure.message, "error");
		} else lines.push(`   ${dot("muted")} ${port}  ${t.fg("muted", `no preview yet. /open ${p.port} publishes one`)}`);
	}

	const outputs = shownOutputs({ ...detail, previews });
	heading("Outputs", outputs.length);
	if (outputs.length === 0) lines.push(`   ${t.fg("dim", "No outputs yet.")}`);
	for (const o of outputs) lines.push(`   ${t.fg("muted", o.kind.padEnd(8))} ${o.ref}`);

	heading("Sessions", detail.sessions.length);
	if (detail.sessions.length === 0) lines.push(`   ${t.fg("dim", "No sessions.")}`);
	for (const s of detail.sessions) {
		const id = s.harnessSessionId ? t.fg("dim", `  session ${s.harnessSessionId}`) : "";
		lines.push(`   ${(harnessLabel[s.harness] ?? s.harness).padEnd(12)} ${state(s.status, sessionTone[s.status] ?? "muted")}  ${t.fg("dim", s.herdrPane)}${id}`);
	}
	heading("Attach from a shell in the pylon");
	lines.push(`   ${t.fg("mdCode", detail.attach)}`);
	return lines.map((line) => truncateToWidth(line, width));
}
