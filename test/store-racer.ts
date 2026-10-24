/**
 * One pi session's look, for the store's lock tests: `bun test/store-racer.ts <file> <thread> <at> <holdMs>` marks
 * `thread` at `at`. Between reading the store and writing it, it prints `held` and holds for `holdMs`, so a test can
 * start a second session, or touch the lock, while this one holds it.
 */
import { viewedFile } from "../extensions/nexus/store.ts";

const [file, thread, at, holdMs] = process.argv.slice(2);
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
viewedFile(file!, () => 1, () => {
	process.stdout.write("held\n");
	sleep(Number(holdMs));
}).mark(thread!, Number(at));
