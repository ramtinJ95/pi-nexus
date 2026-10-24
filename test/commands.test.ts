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

	test("strip takes on or off", () => {
		expect(parseCommand("strip on")).toEqual({ name: "strip", on: true });
		expect(parseCommand("strip off")).toEqual({ name: "strip", on: false });
		expect(invalid("strip")).toStartWith("strip needs on or off\n/nexus");
		expect(invalid("strip maybe")).toStartWith("strip needs on or off\n/nexus");
	});

	test("project shows the scope, switches it to a project or all of them, and adds one", () => {
		expect(parseCommand("project")).toEqual({ name: "scope" });
		expect(parseCommand("project spoon")).toEqual({ name: "scope", project: "spoon" });
		expect(parseCommand("project all")).toEqual({ name: "scope", project: null });
		expect(parseCommand("project add spoon git@github.com:me/spoon.git --node firebat")).toEqual({
			name: "add-project",
			id: "spoon",
			repoUrl: "git@github.com:me/spoon.git",
			node: "firebat",
		});
		expect(parseCommand("project add spoon https://github.com/me/spoon --branch=trunk --node=nuc")).toEqual({
			name: "add-project",
			id: "spoon",
			repoUrl: "https://github.com/me/spoon",
			node: "nuc",
			branch: "trunk",
		});
		expect(invalid("project spoon fork")).toStartWith("project takes one argument, or add\n/nexus");
		expect(invalid("project add spoon --node firebat")).toStartWith("project add needs an ID and a repo URL\n/nexus");
		expect(invalid("project add spoon git@x:spoon")).toStartWith("project add needs --node <node>\n/nexus");
		expect(invalid("project add spoon git@x:spoon --node")).toStartWith("project add needs a node after --node\n/nexus");
		expect(invalid("project add spoon git@x:spoon --node n --cpus 4")).toStartWith("project add takes only --node and --branch, got --cpus\n/nexus");
	});

	test("session opens with a harness and title in either spelling, closes with or without a pane, and attaches", () => {
		expect(parseCommand("session open 0123")).toEqual({ name: "session-open", thread: "0123" });
		expect(parseCommand('session open 0123 --harness pi --title "log in"')).toEqual({ name: "session-open", thread: "0123", harness: "pi", title: "log in" });
		expect(parseCommand("session open --title=-review --harness=shell 0123")).toEqual({ name: "session-open", thread: "0123", harness: "shell", title: "-review" });
		expect(parseCommand("session close 0123")).toEqual({ name: "session-close", thread: "0123" });
		expect(parseCommand("session close 0123 %3")).toEqual({ name: "session-close", thread: "0123", pane: "%3" });
		expect(parseCommand("session attach 0123")).toEqual({ name: "attach", thread: "0123" });
		expect(invalid("session")).toStartWith("session needs open, close or attach\n/nexus");
		expect(invalid("session list 0123")).toStartWith("session has no command list\n/nexus");
		expect(invalid("session open")).toStartWith("session open needs a thread\n/nexus");
		expect(invalid("session open 0123 --harness codex")).toStartWith("session open needs a harness of claude-code, pi, shell, got codex\n/nexus");
		expect(invalid("session open 0123 --node n")).toStartWith("session open takes only --harness and --title, got --node\n/nexus");
		expect(invalid("session open 0123 --title")).toStartWith("session open needs a title after --title\n/nexus");
		expect(invalid("session close")).toStartWith("session close needs a thread, and may name a pane\n/nexus");
		expect(invalid("session attach 0123 %3")).toStartWith("session attach needs a thread\n/nexus");
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

	test("completes project, then all, add and the projects the threads are on", () => {
		expect(complete("pro", threads)?.map((i) => i.value)).toEqual(["project"]);
		expect(complete("project ", threads)?.map((i) => i.value)).toEqual(["project all", "project add", "project acme"]);
		expect(complete("project a", threads)?.map((i) => i.value)).toEqual(["project all", "project add", "project acme"]);
		expect(complete("project ac", threads)?.map((i) => i.value)).toEqual(["project acme"]);
		expect(complete("project add x", threads)).toBeNull();
	});

	test("completes session, then open, close and attach, then a thread", () => {
		expect(complete("ses", threads)?.map((i) => i.value)).toEqual(["session"]);
		expect(complete("session ", threads)?.map((i) => i.value)).toEqual(["session open", "session close", "session attach"]);
		expect(complete("session a", threads)?.map((i) => i.value)).toEqual(["session attach"]);
		expect(complete("session attach 0123456789c", threads)?.map((i) => i.value)).toEqual([`session attach ${idB}`]);
		expect(complete("session list 0123", threads)).toBeNull();
		expect(complete(`session close ${idA} %`, threads)).toBeNull();
	});
});
