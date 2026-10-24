/**
 * One pi session's change to a store, for the stores' lock tests. `bun test/store-racer.ts <file> <thread> <at> <holdMs>`
 * marks `thread` at `at` in the looks store, and `bun test/store-racer.ts --settings <file> <change> <holdMs>` changes
 * the settings by the JSON `change`. Between reading the store and writing it, it prints `held` and holds for `holdMs`,
 * so a test can start a second session, or touch the lock, while this one holds it.
 */
import { settingsFile, viewedFile } from "../extensions/nexus/store.ts";

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const hold = (ms: string | undefined) => () => {
	process.stdout.write("held\n");
	sleep(Number(ms));
};
if (process.argv[2] === "--settings") {
	const [file, change, holdMs] = process.argv.slice(3);
	settingsFile(file!, hold(holdMs)).update(JSON.parse(change!));
} else {
	const [file, thread, at, holdMs] = process.argv.slice(2);
	viewedFile(file!, () => 1, hold(holdMs)).mark(thread!, Number(at));
}
