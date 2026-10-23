/**
 * The nexus CLI as a child process, which is the only way pi-nexus reaches Nexus. The CLI owns the control plane's
 * URL and proxy, so nothing here knows either.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
	emptyView,
	isThreadId,
	NexusError,
	isSettled,
	reduce,
	resolveThread,
	type ErrorKind,
	type Thread,
	type ThreadState,
	type ThreadView,
	type WatchEvent,
} from "./thread.ts";

export interface Nexus {
	/** Runs `nexus <command> --json <args>` and returns what it printed. */
	run(args: readonly string[], signal?: AbortSignal): Promise<unknown>;
	/** Streams `nexus watch <thread> --json` until the thread is deleted or `signal` aborts. */
	watch(thread: string, onEvent: (event: WatchEvent) => void, signal: AbortSignal): Promise<void>;
}

export const defaultBin = () => process.env.NEXUS_BIN || "nexus";

const kinds: Readonly<Record<number, ErrorKind>> = { 1: "failed", 2: "unreachable", 3: "refused", 4: "not-found", 5: "conflict", 64: "invalid" };
const watchTypes = new Set(["reset", "entry", "state", "error"]);

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
				const child = spawn(bin, [args[0]!, "--json", ...args.slice(1)], { stdio: ["ignore", "pipe", "pipe"], signal });
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
					let event: WatchEvent;
					try {
						event = JSON.parse(line) as WatchEvent;
					} catch {
						broken = new NexusError("failed", `nexus watch printed a line that is not JSON: ${line.slice(0, 200)}`);
						return stop();
					}
					if (watchTypes.has(event.type)) onEvent(event);
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

export const listThreads = (nexus: Nexus, args: readonly string[] = [], signal?: AbortSignal) =>
	nexus.run(["threads", ...args], signal) as Promise<Thread[]>;

/** Starts a thread with its first message. `=` keeps a value that starts with a dash from reading as a flag. */
export const startThread = (nexus: Nexus, start: { project: string; message: string; title?: string }, signal?: AbortSignal) =>
	nexus.run(
		["start", `--project=${start.project}`, `--message=${start.message}`, ...(start.title ? [`--title=${start.title}`] : [])],
		signal,
	) as Promise<Thread>;

/** Sends `text` as it is, after `--` so that no part of it reads as a flag. */
export const sendText = (nexus: Nexus, thread: string, text: string, steer: boolean, signal?: AbortSignal) =>
	nexus.run(["send", thread, ...(steer ? ["--steer"] : []), "--", text], signal);

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
