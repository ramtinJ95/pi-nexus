/**
 * One pi session's look, for the store's race test: `bun test/store-racer.ts <file> <thread> <at> <holdMs>` marks
 * `thread` at `at`, holding for `holdMs` between reading the store and writing it, so two of these interleave.
 */
import { viewedFile } from "../extensions/nexus/store.ts";

const [file, thread, at, holdMs] = process.argv.slice(2);
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
viewedFile(file!, () => 1, () => sleep(Number(holdMs))).mark(thread!, Number(at));
