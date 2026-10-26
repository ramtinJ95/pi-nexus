/**
 * What pi-nexus keeps in pi's agent directory rather than in one session, since the person's choices outlive the
 * session that made them: the console's settings. Every pi session on this Mac shares the file. When a reply was seen
 * is the control plane's, shared with every client, so nothing here keeps it.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface Settings {
	/** What Changes compares the checkout with, the boot base while absent. */
	base?: "start" | "head" | "turn";
	/** Whether the strip of threads that need you, have news or work shows above the editor. */
	strip: boolean;
	/** The project whose threads the picker, the strip and the status line show, or null for every project. */
	project: string | null;
}

export interface SettingsStore {
	read(): Settings;
	/**
	 * Changes the settings `change` names, keeping what other sessions wrote to the rest. Fails when the file cannot
	 * be written, so the caller can say the setting lasts for this session only.
	 */
	update(change: Partial<Settings>): void;
}

const defaultSettings: Settings = { strip: true, project: null };

/** A file from before projects has no `project`, which reads as every project. */
const isSettings = (value: unknown): value is Partial<Settings> & { strip: boolean } => {
	const project = (value as Partial<Settings> | null)?.project;
	const base = (value as Partial<Settings> | null)?.base;
	return typeof value === "object" && value !== null && typeof (value as Settings).strip === "boolean" && (base === undefined || base === "start" || base === "head" || base === "turn") && (project === undefined || project === null || typeof project === "string");
};

const directory = () => path.join(getAgentDir(), "pi-nexus");
export const defaultSettingsFile = () => path.join(directory(), "settings.json");

/** A lock whose owner cannot be read, older than this, was left by a session that died while taking it. */
const staleLockMs = 5_000;
/** How long a change waits for another session's before it fails. */
const lockWaitMs = 2_000;

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The lock's content, or undefined once it is gone. */
function lockOwner(lock: string): string | undefined {
	try {
		return readFileSync(lock, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
}

/**
 * Whether the session that wrote `owner`, `<pid> <random id>`, has died. A lock whose pid cannot be read, as while
 * its owner is still writing it, counts as abandoned only once stale. A live pid holds the lock however old it is.
 */
function abandoned(lock: string, owner: string): boolean {
	const pid = Number(owner.split(" ")[0]);
	if (!Number.isInteger(pid) || pid <= 0) {
		try {
			return Date.now() - statSync(lock).mtimeMs > staleLockMs;
		} catch (err) {
			// Released meanwhile, so the next try takes it.
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw err;
		}
	}
	try {
		process.kill(pid, 0);
		return false;
	} catch (err) {
		// EPERM is a live process of another user.
		return (err as NodeJS.ErrnoException).code === "ESRCH";
	}
}

/**
 * Runs `change` holding `<file>.lock`, created exclusively with this session's token in it, so two pi sessions'
 * read-merge-writes of one file take turns instead of renaming over each other. A lock whose session died is taken
 * over, and a session removes the lock only while it still holds its own token.
 */
function locked<T>(file: string, change: () => T): T {
	const lock = `${file}.lock`;
	const token = `${process.pid} ${randomUUID()}`;
	mkdirSync(path.dirname(file), { recursive: true });
	const deadline = Date.now() + lockWaitMs;
	for (;;) {
		try {
			writeFileSync(lock, token, { flag: "wx" });
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
		const owner = lockOwner(lock);
		if (owner === undefined) continue;
		if (abandoned(lock, owner)) {
			// Only the lock judged abandoned goes, not one another session took over meanwhile.
			if (lockOwner(lock) === owner) unlinkSync(lock);
			continue;
		}
		if (Date.now() > deadline) throw new Error(`${lock} is held by another pi session`);
		sleep(10);
	}
	try {
		return change();
	} finally {
		if (lockOwner(lock) === token) unlinkSync(lock);
	}
}

/** A JSON file that reads as undefined when it is missing or does not hold what `is` expects, and writes atomically. */
function jsonFile<T>(file: string, is: (value: unknown) => value is T) {
	return {
		load(): T | undefined {
			try {
				const value: unknown = JSON.parse(readFileSync(file, "utf8"));
				return is(value) ? value : undefined;
			} catch {
				return undefined;
			}
		},
		write(value: T): T {
			mkdirSync(path.dirname(file), { recursive: true });
			const temp = `${file}.${process.pid}.tmp`;
			writeFileSync(temp, `${JSON.stringify(value)}\n`);
			renameSync(temp, file);
			return value;
		},
	};
}

/**
 * The settings at `file`, the defaults while it is missing or does not parse. A change merges with what other sessions
 * wrote, under a lock, so two sessions changing different settings keep both. `held` runs between a change's read and
 * its write, where a test holds to race two sessions.
 */
export function settingsFile(file: string, held: () => void = () => {}): SettingsStore {
	const store = jsonFile(file, isSettings);
	const read = (): Settings => ({ ...defaultSettings, ...store.load() });
	return {
		read,
		update(change) {
			locked(file, () => {
				const settings = read();
				held();
				store.write({ ...settings, ...change });
			});
		},
	};
}

/**
 * Removes the looks store that pi-nexus kept before the control plane shared when each reply was seen. Nothing reads
 * it, so a file that cannot be removed only stays behind.
 */
export function forgetLooks(file = path.join(directory(), "viewed.json")): void {
	try {
		rmSync(file, { force: true });
	} catch {}
}
