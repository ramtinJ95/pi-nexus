/**
 * What pi-nexus keeps in pi's agent directory rather than in one session, since threads and the person's choices
 * outlive the session that made them: when each thread was last looked at, and the console's settings. Every pi
 * session on this Mac shares the files.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** The looks as last read. A thread nobody has looked at counts its agent's activity from `since`. */
export interface Seen {
	since: number;
	threads: Readonly<Record<string, number>>;
}

export interface Viewed {
	read(): Seen;
	/** Records a look at `thread` at `at`. */
	mark(thread: string, at: number): void;
}

export interface Settings {
	/** Whether the strip of threads that need you, have news or work shows above the editor. */
	strip: boolean;
}

export interface SettingsStore {
	read(): Settings;
	/** Fails when the file cannot be written, so the caller can say the setting lasts for this session only. */
	write(settings: Settings): void;
}

const defaultSettings: Settings = { strip: true };

const isSeen = (value: unknown): value is Seen =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as Seen).since === "number" &&
	typeof (value as Seen).threads === "object" &&
	(value as Seen).threads !== null &&
	Object.values((value as Seen).threads).every((at) => typeof at === "number");

const isSettings = (value: unknown): value is Settings => typeof value === "object" && value !== null && typeof (value as Settings).strip === "boolean";

const directory = () => path.join(getAgentDir(), "pi-nexus");
export const defaultViewedFile = () => path.join(directory(), "viewed.json");
export const defaultSettingsFile = () => path.join(directory(), "settings.json");

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
 * The looks at `file`. A missing file starts from the first read. A file that does not parse starts afresh too, so a
 * broken store costs the markers, never the console. Only `mark` fails when the file cannot be written, so the
 * console can say so. A look merges with what other sessions wrote, keeping the later time of each thread.
 */
export function viewedFile(file: string, now: () => number = Date.now): Viewed {
	const store = jsonFile(file, isSeen);
	/** The start of a store that could not be written, kept so its markers hold still until a look says why. */
	let unwritten: Seen | undefined;
	return {
		read() {
			const seen = store.load();
			if (seen !== undefined) return seen;
			unwritten ??= { since: now(), threads: {} };
			try {
				return store.write(unwritten);
			} catch {
				return unwritten;
			}
		},
		mark(thread, at) {
			const seen = store.load() ?? { since: now(), threads: {} };
			store.write({ since: seen.since, threads: { ...seen.threads, [thread]: Math.max(seen.threads[thread] ?? 0, at) } });
		},
	};
}

/** The settings at `file`, the defaults while it is missing or does not parse. */
export function settingsFile(file: string): SettingsStore {
	const store = jsonFile(file, isSettings);
	return {
		read: () => store.load() ?? defaultSettings,
		write: (settings) => void store.write(settings),
	};
}
