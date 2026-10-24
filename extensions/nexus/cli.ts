/**
 * The nexus CLI as a child process, which is the only way pi-nexus reaches Nexus. The CLI owns the control plane's
 * URL and proxy, so nothing here knows either.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Type } from "typebox";
import { NodeSummary, parse, Preview, Project, Thread, ThreadDetail, ThreadRow, Unpreviewed, watchEvents, type ThreadState, type WatchEvent } from "./contract.ts";
import { emptyView, isThreadId, NexusError, isSettled, portBusy, reduce, resolveThread, type ErrorKind, type ThreadView } from "./thread.ts";

export interface Nexus {
	/** Runs `nexus <command> --json <args>` and returns what it printed. A command of two words, such as `project add`, is one item. */
	run(args: readonly string[], signal?: AbortSignal): Promise<unknown>;
	/** Streams `nexus watch <thread> --json` until the thread is deleted or `signal` aborts. */
	watch(thread: string, onEvent: (event: WatchEvent) => void, signal: AbortSignal): Promise<void>;
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

export function createNexus(bin: string = defaultBin()): Nexus {
	return {
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
	};
}

export async function listThreads(nexus: Nexus, args: readonly string[] = [], signal?: AbortSignal): Promise<ThreadRow[]> {
	const rows = parse(Type.Array(Type.Unknown()), await nexus.run(["threads", ...args], signal), "nexus threads");
	return rows.map((row, i) => {
		const id = (row as { id?: unknown } | null)?.id;
		return parse(ThreadRow, row, `nexus threads' row for ${typeof id === "string" ? id : `its item ${i}`}`);
	});
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
export const sendText = (nexus: Nexus, thread: string, text: string, steer: boolean, signal?: AbortSignal, requestId?: string) =>
	nexus.run(["send", thread, ...(steer ? ["--steer"] : []), ...(requestId ? [`--request-id=${requestId}`] : []), "--", text], signal);

export const showThread = async (nexus: Nexus, thread: string, signal?: AbortSignal) =>
	parse(ThreadDetail, await nexus.run(["show", thread], signal), `nexus show ${thread}`);
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
			if (err instanceof NexusError && err.kind === "invalid" && err.message === "unknown command unpreview") {
				throw new NexusError("invalid", "nexus has no unpreview command: unpublishing a preview needs Nexus CLI 0.3.0 or later (nexus --version)");
			}
			throw err;
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
		if (err instanceof NexusError && err.kind === "invalid" && err.message === "unknown command project") {
			throw new NexusError("invalid", "nexus has no project add command: adding a project needs Nexus CLI 0.4.0 or later (nexus --version)");
		}
		throw err;
	}
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
