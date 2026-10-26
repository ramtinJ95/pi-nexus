/**
 * One pi session's change to the settings, for the store's lock tests. `bun test/store-racer.ts <file> <change> <holdMs>`
 * changes the settings by the JSON `change`. Between reading the store and writing it, it prints `held` and holds for
 * `holdMs`, so a test can start a second session, or touch the lock, while this one holds it.
 */
import { settingsFile } from "../extensions/nexus/store.ts";

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const [file, change, holdMs] = process.argv.slice(2);
settingsFile(file!, () => {
	process.stdout.write("held\n");
	sleep(Number(holdMs));
}).update(JSON.parse(change!));
