/**
 * The nexus CLI as a child process, which is the only way pi-nexus reaches Nexus. The CLI owns the control plane's
 * URL and proxy, so nothing here knows either.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Type } from "typebox";
import { Changes, Diff, NodeSummary, OpenedSession, parse, parseConversation, parseDetail, Preview, Project, Seen, Sent, SessionClosed, Thread, ThreadRow, Unpreviewed, type ThreadDetail, watchEvents, type Base, type ClaudeConversation, type ThreadState, type WatchEvent } from "./contract.ts";
import { emptyView, isThreadId, NexusError, isSettled, portBusy, reduce, resolveThread, type ErrorKind, type ThreadView } from "./thread.ts";

export interface Nexus {
	/** The CLI binary this runs, which a command a person runs themselves names too. */
	readonly bin: string;
	/** Runs `nexus <command> --json <args>` and returns what it printed. A command of two words, such as `project add`, is one item. */
	run(args: readonly string[], signal?: AbortSignal): Promise<unknown>;
	/** Streams `nexus watch <thread> --json` until the thread is deleted or `signal` aborts. */
	watch(thread: string, onEvent: (event: WatchEvent) => void, signal: AbortSignal): Promise<void>;
	/** Runs `nexus attach <thread> --json` on this process's terminal, and resolves once the person detaches. */
	attach(thread: string): Promise<void>;
	/** Runs `nexus --version` and returns what it printed, such as `nexus 0.8.0`. */
	version(signal?: AbortSignal): Promise<string>;
}

export const defaultBin = () => process.env.NEXUS_BIN || "nexus";

const kinds: Readonly<Record<number, ErrorKind>> = { 1: "failed", 2: "unreachable", 3: "refused", 4: "not-found", 5: "conflict", 64: "invalid" };

/** The CLI's stderr line `{"error", "kind", "status"}`, or the exit code's kind when stderr holds something else. */
function failure(code: number | null, stderr: string): NexusError {
	const last = stderr.trim().split("\n").at(-1) ?? "";
	try {
		const reported = JSON.parse(last) as { error?: unknown; kind?: unknown };
		if (typeof reported.error === "string" && Object.values(kinds).includes(reported.kind as ErrorKind)) {
			return new NexusError(reported.kind as ErrorKind, reported.error);
		}
	} catch {}
	return new NexusError((code !== null && kinds[code]) || "failed", stderr.trim() || `nexus exited with code ${code}`);
}

const spawnFailure = (bin: string, err: Error) =>
	new NexusError("failed", `cannot run ${bin}: ${err.message}. Install the nexus CLI or point NEXUS_BIN at it`);

/** `err`, or for a CLI too old to have `command`, an error that names the version `doing` needs. */
function newer(err: unknown, command: string, doing: string, version: string, update = false): unknown {
	if (err instanceof NexusError && err.kind === "invalid" && err.message === `unknown command ${command.split(" ")[0]}`) {
		return new NexusError("invalid", `nexus has no ${command} command: ${doing} needs Nexus CLI ${version} or later (nexus --version)${update ? ". Update the nexus CLI." : ""}`);
	}
	return err;
}

/** How much of an attach's stderr is kept for its failure, whose own line comes last. */
const attachStderrKept = 8_192;

export function createNexus(bin: string = defaultBin()): Nexus {
	return {
		bin,
		run(args, signal) {
			return new Promise((resolve, reject) => {
				// --json goes before the arguments, since an argument after `--` takes everything that follows as text.
				const child = spawn(bin, [...args[0]!.split(" "), "--json", ...args.slice(1)], { stdio: ["ignore", "pipe", "pipe"], signal });
				let stdout = "";
				let stderr = "";
				child.stdout.on("data", (chunk) => (stdout += chunk));
				child.stderr.on("data", (chunk) => (stderr += chunk));
				child.on("error", (err) => reject(err.name === "AbortError" ? err : spawnFailure(bin, err)));
				child.on("close", (code) => {
					if (code !== 0) return reject(failure(code, stderr));
					try {
						resolve(JSON.parse(stdout));
					} catch {
						reject(new NexusError("failed", `nexus ${args[0]} printed something other than JSON: ${stdout.slice(0, 200)}`));
					}
				});
			});
		},

		watch(thread, onEvent, signal) {
			return new Promise((resolve, reject) => {
				const child = spawn(bin, ["watch", thread, "--json"], { stdio: ["ignore", "pipe", "pipe"] });
				let stderr = "";
				let broken: NexusError | undefined;
				const stop = () => child.kill("SIGTERM");
				child.stderr.on("data", (chunk) => (stderr += chunk));
				createInterface({ input: child.stdout }).on("line", (line) => {
					if (line.trim() === "" || broken || signal.aborted) return;
					let printed: unknown;
					try {
						printed = JSON.parse(line);
					} catch {
						broken = new NexusError("failed", `nexus watch printed a line that is not JSON: ${line.slice(0, 200)}`);
						return stop();
					}
					// The contract asks a consumer to skip the event types it does not know.
					const type = (printed as { type?: unknown } | null)?.type;
					if (typeof type !== "string" || !Object.hasOwn(watchEvents, type)) return;
					// A failure here, the contract's or a handler's, ends the watch with it rather than escaping the stream.
					try {
						onEvent(parse(watchEvents[type as keyof typeof watchEvents], printed, `a ${type} event of nexus watch`) as WatchEvent);
					} catch (err) {
						broken = err instanceof NexusError ? err : new NexusError("failed", `handling a ${type} event of nexus watch failed: ${err instanceof Error ? err.message : String(err)}`);
						stop();
					}
				});
				signal.addEventListener("abort", stop, { once: true });
				if (signal.aborted) stop();
				child.on("error", (err) => reject(spawnFailure(bin, err)));
				child.on("close", (code) => {
					signal.removeEventListener("abort", stop);
					if (broken) reject(broken);
					else if (code === 0 || signal.aborted) resolve();
					else reject(failure(code, stderr));
				});
			});
		},

		version(signal) {
			return new Promise((resolve, reject) => {
				const child = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "pipe"], signal });
				let stdout = "";
				let stderr = "";
				child.stdout.on("data", (chunk) => (stdout += chunk));
				child.stderr.on("data", (chunk) => (stderr += chunk));
				child.on("error", (err) => reject(err.name === "AbortError" ? err : spawnFailure(bin, err)));
				child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(failure(code, stderr))));
			});
		},

		attach(thread) {
			return new Promise((resolve, reject) => {
				// The terminal is the CLI's, then Herdr's. Its stderr goes on to the terminal as it comes, so the CLI's
				// waiting lines show, and its tail is kept, so a failure reads as the CLI's own.
				const child = spawn(bin, ["attach", "--json", thread], { stdio: ["inherit", "inherit", "pipe"] });
				let stderr = "";
				child.stderr.on("data", (chunk: Buffer) => {
					process.stderr.write(chunk);
					stderr = (stderr + chunk.toString()).slice(-attachStderrKept);
				});
				child.on("error", (err) => reject(spawnFailure(bin, err)));
				child.on("close", (code, signal) => {
					if (code === 0) resolve();
					// Ctrl+C before Herdr takes the terminal stops the CLI by signal, with no line of its own.
					else if (signal !== null) reject(new NexusError("failed", `nexus attach stopped on ${signal}`));
					else reject(failure(code, stderr));
				});
			});
		},
	};
}

export async function listThreads(nexus: Nexus, args: readonly string[] = [], signal?: AbortSignal): Promise<ThreadRow[]> {
	const rows = parse(Type.Array(Type.Unknown()), await nexus.run(["threads", ...args], signal), "nexus threads");
	try {
		return rows.map((row, i) => {
			const id = (row as { id?: unknown } | null)?.id;
			return parse(ThreadRow, row, `nexus threads' row for ${typeof id === "string" ? id : `its item ${i}`}`);
		});
	} catch (err) {
		throw await seenless(nexus, err, signal);
	}
}

/** Starts a thread. `=` keeps a value that starts with a dash from reading as a flag. The CLI needs a title or a message. */
export async function startThread(
	nexus: Nexus,
	start: { project: string; message?: string; title?: string; node?: string; branch?: string },
	signal?: AbortSignal,
): Promise<Thread> {
	const flags = (["message", "title", "node", "branch"] as const).flatMap((key) => (start[key] ? [`--${key}=${start[key]}`] : []));
	return parse(Thread, await nexus.run(["start", `--project=${start.project}`, ...flags], signal), "nexus start");
}

/**
 * Sends `text` as it is, after `--` so that no part of it reads as a flag. A retry of a send whose reply was lost
 * passes the same `requestId`, so the API takes it as the same message.
 */
export const sendText = async (nexus: Nexus, thread: string, text: string, steer: boolean, signal?: AbortSignal, requestId?: string): Promise<Sent> =>
	parse(Sent, await nexus.run(["send", thread, ...(steer ? ["--steer"] : []), ...(requestId ? [`--request-id=${requestId}`] : []), "--", text], signal), "nexus send");

export async function showThread(nexus: Nexus, thread: string, signal?: AbortSignal): Promise<ThreadDetail> {
	const detail = await nexus.run(["show", thread], signal);
	try {
		return parseDetail(detail, `nexus show ${thread}`);
	} catch (err) {
		throw await seenless(nexus, err, signal);
	}
}

/**
 * `err`, or for a reply without the seen state, `seenAt`, `lastReplyAt` and `attention`, from a CLI older than 0.10.0,
 * the version it needs. A newer CLI's reply without them is the control plane's to fix, so its error stands.
 */
async function seenless(nexus: Nexus, err: unknown, signal?: AbortSignal): Promise<unknown> {
	if (!(err instanceof NexusError && err.kind === "contract" && /has no (?:\[\d+\]\.)?(?:seenAt|lastReplyAt|attention),/.test(err.message))) return err;
	try {
		await requireVersion(nexus, [0, 10, 0], "reading when replies were seen", signal);
	} catch (old) {
		return old;
	}
	return err;
}

/** The flag that picks `base`, after the version check `turn` needs. `--turn` came with CLI 0.11.0. */
async function baseFlags(nexus: Nexus, base: Base["kind"], signal?: AbortSignal): Promise<string[]> {
	if (base === "head") return ["--uncommitted"];
	if (base === "start") return [];
	await requireVersion(nexus, [0, 11, 0], "reading the latest turn's changes", signal);
	return ["--turn"];
}

export async function readChanges(nexus: Nexus, thread: string, base: Base["kind"], signal?: AbortSignal): Promise<Changes> {
	const flags = await baseFlags(nexus, base, signal);
	try {
		return parse(Changes, await nexus.run(["changes", ...flags, "--", thread], signal), "nexus changes");
	} catch (err) { throw newer(err, "changes", "reading changes", "0.6.0", true); }
}

export async function readDiff(nexus: Nexus, thread: string, paths: readonly string[], base: Base["kind"], signal?: AbortSignal): Promise<Diff> {
	const flags = await baseFlags(nexus, base, signal);
	try {
		return parse(Diff, await nexus.run(["diff", ...flags, "--", thread, ...paths], signal), "nexus diff");
	} catch (err) { throw newer(err, "diff", "reading diffs", "0.6.0", true); }
}

/**
 * Marks the reply that ended at `shown`, the one a client showed, seen for every client, which needs CLI 0.10.0. It
 * never wakes a pylon and is not human activity. CLI 0.19.0 marks only up to `shown`, so a reply that lands after it
 * stays unread. An older CLI marks the latest reply, so the details are read again first and a newer reply skips the
 * mark; one that lands between that read and the mark is marked too.
 */
export async function markSeen(nexus: Nexus, thread: string, shown: number, signal?: AbortSignal): Promise<void> {
	await requireVersion(nexus, [0, 10, 0], "marking a reply seen", signal);
	if (await hasVersion(nexus, [0, 19, 0], signal)) {
		parse(Seen, await nexus.run(["seen", `--last-reply-at=${shown}`, "--", thread], signal), "nexus seen");
		return;
	}
	const now = await showThread(nexus, thread, signal);
	if (now.lastReplyAt !== shown || (now.seenAt !== null && now.seenAt >= shown)) return;
	parse(Seen, await nexus.run(["seen", "--", thread], signal), "nexus seen");
}

/**
 * A Claude worker's transcript, which needs CLI 0.17.0. Reading never wakes a pylon and is not human activity, but
 * each read makes the control plane read the pylon for up to 5 seconds.
 */
export async function readConversation(nexus: Nexus, thread: string, signal?: AbortSignal): Promise<ClaudeConversation> {
	await requireVersion(nexus, [0, 17, 0], "reading a Claude worker's transcript", signal);
	return parseConversation(await nexus.run(["conversation", "--", thread], signal), `nexus conversation ${thread}`);
}

/** The `thread:port` pairs a publish or unpublish runs on, for each Nexus the session drives. */
const portsChanging = new WeakMap<Nexus, Set<string>>();

/**
 * Runs `change` on the thread's port, refusing it while another publish or unpublish of the same port runs, from the
 * console, a /nexus command or a model tool alike. Two CLI processes on one port could finish in either order, so an
 * older publish could leave a port published after a newer unpublish closed it. A refusal does not queue.
 */
async function changingPort<T>(nexus: Nexus, thread: string, port: number, change: () => Promise<T>): Promise<T> {
	const changing = portsChanging.get(nexus) ?? new Set<string>();
	portsChanging.set(nexus, changing);
	const key = `${thread}:${port}`;
	if (changing.has(key)) throw new NexusError("conflict", portBusy(thread, port));
	changing.add(key);
	try {
		return await change();
	} finally {
		changing.delete(key);
	}
}

/**
 * Publishes `port` of the thread's pylon as a preview and waits, up to the CLI's two minutes, until the node serves
 * it. An abort ends the wait, but the port may be published by then.
 */
export const previewPort = (nexus: Nexus, thread: string, port: number, signal?: AbortSignal) =>
	changingPort(nexus, thread, port, async () => parse(Preview, await nexus.run(["preview", thread, String(port), "--wait"], signal), "nexus preview"));
/**
 * Unpublishes the preview of `port`, which a port with none already is. A paused pylon is woken first, so it can take
 * up to the CLI's two minutes. An abort ends the wait, but the preview may be gone by then. The CLI refuses a
 * declared or ad hoc service's preview.
 */
export const unpreviewPort = (nexus: Nexus, thread: string, port: number, signal?: AbortSignal): Promise<void> =>
	changingPort(nexus, thread, port, async () => {
		try {
			parse(Unpreviewed, await nexus.run(["unpreview", thread, String(port)], signal), "nexus unpreview");
		} catch (err) {
			throw newer(err, "unpreview", "unpublishing a preview", "0.3.0");
		}
	});
export const listProjects = async (nexus: Nexus, signal?: AbortSignal) => parse(Type.Array(Project), await nexus.run(["projects"], signal), "nexus projects");

/**
 * Adds a project, which needs CLI 0.4.0. `=` keeps a node or branch that starts with a dash from reading as a flag, and
 * `--` does the same for the ID and the repo URL.
 */
export async function addProject(nexus: Nexus, add: { id: string; repoUrl: string; node: string; branch?: string }, signal?: AbortSignal): Promise<Project> {
	const flags = [`--node=${add.node}`, ...(add.branch ? [`--branch=${add.branch}`] : [])];
	try {
		return parse(Project, await nexus.run(["project add", ...flags, "--", add.id, add.repoUrl], signal), "nexus project add");
	} catch (err) {
		throw newer(err, "project add", "adding a project", "0.4.0");
	}
}

export interface ModelProject {
	id: string;
	repo_url?: string;
	scratch?: boolean;
	node?: string;
	branch?: string;
	cpus?: number;
	memory_gib?: number;
	disk_gib?: number;
	allow_hosts?: string[];
	logins?: ("claude" | "chatgpt")[];
	github?: boolean;
}

export async function addModelProject(nexus: Nexus, add: ModelProject, signal?: AbortSignal): Promise<Project> {
	if (!add.id.trim()) throw new NexusError("failed", "id is required");
	if ((add.repo_url !== undefined) === (add.scratch === true)) throw new NexusError("failed", "provide exactly one of repo_url or scratch: true");
	if (add.repo_url !== undefined && !add.repo_url.trim()) throw new NexusError("failed", "repo_url is required");
	const node = add.node ?? (await listNodes(nexus, signal)).find((node) => node.state === "online")?.name;
	if (node === undefined) throw new NexusError("failed", "no online node is available; provide node explicitly");
	const flags = [`--node=${node}`, `--branch=${add.branch ?? "main"}`];
	if (add.scratch === true) flags.push("--scratch");
	for (const [key, flag] of [["cpus", "cpus"], ["memory_gib", "memory"], ["disk_gib", "disk"]] as const) {
		if (add[key] !== undefined) flags.push(`--${flag}=${add[key]}`);
	}
	for (const host of add.allow_hosts ?? []) flags.push(`--allow-host=${host}`);
	for (const login of add.logins ?? []) flags.push(`--login=${login}`);
	// Never let model-supplied hosts or secret names change this credential grant.
	if (add.github === true) flags.push("--secret=GH_TOKEN:api.github.com,github.com");
	try {
		return parse(Project, await nexus.run(["project add", ...flags, "--", add.id.trim(), ...(add.repo_url !== undefined ? [add.repo_url.trim()] : [])], signal), "nexus project add");
	} catch (err) {
		if (err instanceof NexusError && err.kind === "invalid" && /^Unknown option '--(?:scratch|secret)'(?:\.|$)/.test(err.message)) {
			throw new NexusError("invalid", `${err.message}: adding a project with --scratch or --secret needs Nexus CLI 0.7.0 or later (nexus --version). Update the nexus CLI.`);
		}
		throw newer(err, "project add", "adding a project", "0.7.0", true);
	}
}

/**
 * Opens a session in the pylon, which needs CLI 0.5.0: a Herdr workspace with the harness's agent in it, Claude Code
 * unless `harness` names another, titled with the harness's name unless `title` is given. A paused pylon is woken
 * first, and the agent can take most of a minute to start, so this can take up to the CLI's two minutes. An abort
 * ends the wait, but the session may open all the same. `=` keeps a title that starts with a dash from reading as a
 * flag.
 */
export async function openSession(nexus: Nexus, thread: string, open: { harness?: string; title?: string }, signal?: AbortSignal): Promise<OpenedSession> {
	const flags = (["harness", "title"] as const).flatMap((key) => (open[key] ? [`--${key}=${open[key]}`] : []));
	try {
		return parse(OpenedSession, await nexus.run(["session open", ...flags, "--", thread], signal), "nexus session open");
	} catch (err) {
		throw newer(err, "session open", "opening a session", "0.5.0");
	}
}

/** `nexus 0.8.0` as [0, 8, 0], or null when it names no version. */
export function parseVersion(printed: string): number[] | null {
	const match = /^nexus (\d+)\.(\d+)\.(\d+)\b/.exec(printed.trim());
	return match ? match.slice(1).map(Number) : null;
}

/** Whether `version` comes before `than`. */
export const isOlder = (version: readonly number[], than: readonly number[]) => {
	const at = version.findIndex((part, i) => part !== than[i]);
	return at !== -1 && version[at]! < than[at]!;
};

/**
 * The CLI versions read that were new enough for what asked, by Nexus. Only those are kept, so a CLI updated after a
 * refusal is read again rather than refused from memory.
 */
const versionsRead = new WeakMap<Nexus, Map<string, number[]>>();

/** Whether the CLI is `needed` or later. One whose version cannot be read is not. */
async function hasVersion(nexus: Nexus, needed: readonly number[], signal?: AbortSignal): Promise<boolean> {
	const wanted = needed.join(".");
	const known = versionsRead.get(nexus) ?? new Map<string, number[]>();
	versionsRead.set(nexus, known);
	if (known.has(wanted)) return true;
	const version = parseVersion(await nexus.version(signal));
	if (version === null || isOlder(version, needed)) return false;
	known.set(wanted, version);
	return true;
}

/**
 * Fails unless the CLI is `needed` or later, saying which version `doing` needs. A version that cannot be read
 * fails too, since an older CLI could do the wrong thing.
 */
async function requireVersion(nexus: Nexus, needed: readonly number[], doing: string, signal?: AbortSignal): Promise<void> {
	const wanted = needed.join(".");
	const known = versionsRead.get(nexus) ?? new Map<string, number[]>();
	versionsRead.set(nexus, known);
	if (known.has(wanted)) return;
	const printed = await nexus.version(signal);
	const version = parseVersion(printed);
	if (version === null) throw new NexusError("invalid", `${nexus.bin} --version printed no version (${JSON.stringify(printed.trim().slice(0, 80))}): ${doing} needs Nexus CLI ${wanted} or later`);
	if (isOlder(version, needed)) throw new NexusError("invalid", `${nexus.bin} is ${version.join(".")}: ${doing} needs Nexus CLI ${wanted} or later (nexus --version)`);
	known.set(wanted, version);
}

/**
 * Closes a session by its `id`, which needs CLI 0.8.0. Closing a pane ends its agent, and closing a failed session
 * drops it, so no wake tries it again. CLI 0.8.0 passes on at once the control plane's refusal of a paused session and
 * its failure on a pane that is not open, which a wake may have moved, in their words. An older CLI is refused before it
 * runs: it asks again for two minutes on a paused session, and a wake meanwhile would close it unasked.
 */
export async function closeSession(nexus: Nexus, thread: string, id: string, signal?: AbortSignal): Promise<void> {
	await requireVersion(nexus, [0, 8, 0], "closing a session", signal);
	try {
		parse(SessionClosed, await nexus.run(["session close", "--", thread, id], signal), "nexus session close");
	} catch (err) {
		throw newer(err, "session close", "closing a session", "0.5.0");
	}
}

/**
 * Gives this process's terminal to the pylon's Herdr session, through `nexus attach`, until the person detaches.
 * The caller must have released the terminal first. It needs CLI 0.9.0, which attaches through the control plane; an
 * older one attaches over ssh, which upgraded nodes refuse.
 */
export async function attachThread(nexus: Nexus, thread: string): Promise<void> {
	await requireVersion(nexus, [0, 9, 0], "attaching");
	await nexus.attach(thread);
}
export const listNodes = async (nexus: Nexus, signal?: AbortSignal) => parse(Type.Array(NodeSummary), await nexus.run(["nodes"], signal), "nexus nodes");

/** A thread ID from an ID or a unique prefix of one. Only a prefix costs a lookup. */
export async function threadId(nexus: Nexus, ref: string, signal?: AbortSignal): Promise<string> {
	return isThreadId(ref) ? ref : resolveThread(ref, (await listThreads(nexus, [], signal)).map((t) => t.id));
}

/** How long a watch stays quiet after an entry before the entry counts without a state behind it. */
const quietMs = 1_000;

/**
 * Folds a watch's events into a view until `check` holds, `event` returns true, `signal` aborts, or the thread is
 * deleted. One poll prints its new entries before the state that changed with them, so `check` stops the watch at
 * once only on a state event. A view that holds after any other event counts after a quiet second, cancelled by the
 * next event, which covers a turn that started and ended between two polls with no state change printed.
 */
export async function watchView(
	nexus: Nexus,
	thread: string,
	on: { event?(event: WatchEvent, view: ThreadView): boolean | void; check(view: ThreadView): boolean },
	signal: AbortSignal,
): Promise<{ view: ThreadView; checked: boolean }> {
	const stop = new AbortController();
	const forward = () => stop.abort();
	signal.addEventListener("abort", forward, { once: true });
	if (signal.aborted) stop.abort();
	let view = emptyView;
	let checked = false;
	let quiet: ReturnType<typeof setTimeout> | undefined;
	const done = () => {
		checked = true;
		stop.abort();
	};
	try {
		await nexus.watch(
			thread,
			(event) => {
				clearTimeout(quiet);
				view = reduce(view, event);
				if (on.event?.(event, view)) return stop.abort();
				if (!on.check(view)) return;
				if (event.type === "state") done();
				else quiet = setTimeout(done, quietMs);
			},
			stop.signal,
		);
	} finally {
		clearTimeout(quiet);
		signal.removeEventListener("abort", forward);
	}
	return { view, checked };
}

const aborted = () => new DOMException("The operation was aborted", "AbortError");

/** The thread's state and conversation at the first poll. An outage before it fails the read with the outage's kind. */
export async function readThread(nexus: Nexus, thread: string, signal?: AbortSignal): Promise<ThreadView & { state: ThreadState }> {
	let outage: NexusError | undefined;
	const { view } = await watchView(
		nexus,
		thread,
		{
			event(event) {
				if (event.type !== "error") return false;
				outage = new NexusError(event.kind, event.message);
				return true;
			},
			check: (v) => v.state !== undefined,
		},
		signal ?? new AbortController().signal,
	);
	if (view.state !== undefined) return { ...view, state: view.state };
	if (outage !== undefined) throw outage;
	throw signal?.aborted ? aborted() : new NexusError("failed", "the watch ended before it reported the thread");
}

export interface Waited {
	view: ThreadView;
	settled: boolean;
	timedOut: boolean;
	cancelled: boolean;
}

/** Watches until the thread settles, `timeoutMs` passes or `signal` aborts. Outages are waited through. */
export async function waitThread(nexus: Nexus, thread: string, timeoutMs: number, signal?: AbortSignal): Promise<Waited> {
	const timeout = AbortSignal.timeout(timeoutMs);
	const { view, checked } = await watchView(nexus, thread, { check: isSettled }, signal ? AbortSignal.any([signal, timeout]) : timeout);
	const cancelled = signal?.aborted === true;
	// A watch that ended by itself ended on the thread's delete.
	const settled = checked || (!cancelled && !timeout.aborted);
	return { view, settled, timedOut: timeout.aborted && !settled, cancelled };
}
