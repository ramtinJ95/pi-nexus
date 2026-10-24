import { describe, expect, test } from "bun:test";
import { complete, parseCommand } from "../extensions/nexus/commands.ts";
import { NexusError } from "../extensions/nexus/thread.ts";
import { idA, idB, threads } from "./fixtures.ts";

function invalid(input: string): string {
	try {
		parseCommand(input);
	} catch (err) {
		if (err instanceof NexusError && err.kind === "invalid") return err.message;
		throw err;
	}
	throw new Error(`${input} parsed`);
}

describe("/nexus arguments", () => {
	test("no arguments opens the picker, and list lists threads", () => {
		expect(parseCommand("")).toEqual({ name: "browse" });
		expect(parseCommand("  ")).toEqual({ name: "browse" });
		expect(parseCommand("list")).toEqual({ name: "list" });
		expect(parseCommand("list acme")).toEqual({ name: "list", project: "acme" });
	});

	test("open takes a thread, and new without a message opens the start form", () => {
		expect(parseCommand("open 0123")).toEqual({ name: "open", thread: "0123" });
		expect(parseCommand("new")).toEqual({ name: "start" });
		expect(parseCommand("new acme")).toEqual({ name: "start", project: "acme" });
		expect(parseCommand("new acme --title 'Flaky test'")).toEqual({ name: "start", project: "acme", title: "Flaky test" });
	});

	test("new keeps the message as typed", () => {
		expect(parseCommand("new acme fix the  'flaky' test, then --push")).toEqual({
			name: "new",
			project: "acme",
			message: "fix the  'flaky' test, then --push",
		});
	});

	test("new takes a title in each spelling", () => {
		const expected = { name: "new" as const, project: "acme", title: "Flaky test", message: "fix it" };
		expect(parseCommand('new acme --title "Flaky test" fix it')).toEqual(expected);
		expect(parseCommand("new acme -t 'Flaky test' fix it")).toEqual(expected);
		expect(parseCommand("new acme --title=Flaky fix it")).toEqual({ ...expected, title: "Flaky" });
	});

	test("a message that is one quoted string loses its quotes", () => {
		expect(parseCommand('send th-01 "hello there"')).toEqual({ name: "send", thread: "th-01", text: "hello there" });
		expect(parseCommand('send th-01 say "hi" now')).toEqual({ name: "send", thread: "th-01", text: 'say "hi" now' });
	});

	test("thread commands take one thread", () => {
		expect(parseCommand("show 0123")).toEqual({ name: "show", thread: "0123" });
		expect(parseCommand("follow 0123")).toEqual({ name: "follow", thread: "0123" });
		expect(parseCommand("retry-pylon 0123")).toEqual({ name: "retry-pylon", thread: "0123" });
		expect(parseCommand("delete 0123")).toEqual({ name: "delete", thread: "0123" });
		expect(parseCommand("unfollow")).toEqual({ name: "unfollow" });
	});

	test("unpublish takes a thread and a port", () => {
		expect(parseCommand("unpublish 0123 8080")).toEqual({ name: "unpublish", thread: "0123", port: 8080 });
		expect(invalid("unpublish 0123")).toStartWith("unpublish needs a port\n/nexus");
		expect(invalid("unpublish 0123 http")).toStartWith("unpublish needs a port from 1 to 65535, got http");
		expect(invalid("unpublish 0123 0")).toStartWith("unpublish needs a port from 1 to 65535, got 0");
		expect(invalid("unpublish 0123 8080 9000")).toStartWith("unpublish takes 2 arguments");
	});

	test("mistakes name the problem and show usage", () => {
		expect(invalid("new acme --title")).toStartWith("new needs a title after --title\n/nexus");
		expect(invalid("open")).toStartWith("open needs a thread");
		expect(invalid("send 0123")).toStartWith("send needs text");
		expect(invalid("show")).toStartWith("show needs a thread");
		expect(invalid("archive a b")).toStartWith("archive takes one argument");
		expect(invalid("frobnicate")).toStartWith("unknown command frobnicate");
	});
});

describe("/nexus completion", () => {
	test("completes command names", () => {
		expect(complete("re", threads)?.map((i) => i.value)).toEqual(["retry", "retry-pylon"]);
		expect(complete("zz", threads)).toBeNull();
	});

	test("completes thread IDs, with or without th-", () => {
		expect(complete("show 0123", threads)?.map((i) => i.value)).toEqual([`show ${idA}`, `show ${idB}`]);
		expect(complete("show th-0123456789c", threads)?.map((i) => i.value)).toEqual([`show ${idB}`]);
		expect(complete("unpublish 0123456789c", threads)?.map((i) => i.value)).toEqual([`unpublish ${idB}`]);
		expect(complete("list a", threads)).toBeNull();
	});
});
