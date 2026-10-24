#!/usr/bin/env node
// A stand-in for the nexus CLI that answers from the scenario file in FAKE_NEXUS and logs its argv to FAKE_NEXUS_LOG.
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_NEXUS_LOG, `${JSON.stringify(argv)}\n`);
const scenario = JSON.parse(readFileSync(process.env.FAKE_NEXUS, "utf8"));
const command = argv[0];
// `after` holds replies that replace `responses` once a command has answered, as `show` changes after `unpreview`.
const answered = `${process.env.FAKE_NEXUS}.answered`;
const ran = existsSync(answered) ? readFileSync(answered, "utf8").split("\n") : [];
const responses = Object.assign({}, scenario.responses, ...Object.entries(scenario.after ?? {}).flatMap(([c, r]) => (ran.includes(c) ? [r] : [])));

const fail = scenario.fail?.[command];
if (fail) {
	process.stderr.write(fail.stderr ?? `${JSON.stringify({ error: fail.error, kind: fail.kind, status: null })}\n`);
	process.exit(fail.exit);
}

// FAKE_NEXUS_PIDS lists every run's start and exit, so a test run can be checked for watches it left behind.
if (process.env.FAKE_NEXUS_PIDS) {
	appendFileSync(process.env.FAKE_NEXUS_PIDS, `${process.pid} start ${command}\n`);
	process.on("exit", () => appendFileSync(process.env.FAKE_NEXUS_PIDS, `${process.pid} exit\n`));
}

if (command === "watch") {
	// watchExitDelayMs stands in for a CLI that takes a while to exit after it is told to stop.
	process.on("SIGTERM", () =>
		setTimeout(() => {
			appendFileSync(process.env.FAKE_NEXUS_LOG, `${JSON.stringify(["<watch ended>", argv[1]])}\n`);
			process.exit(0);
		}, scenario.watchExitDelayMs ?? 0),
	);
	for (const step of scenario.watch ?? []) {
		if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
		process.stdout.write(`${typeof step.event === "string" ? step.event : JSON.stringify(step.event)}\n`);
	}
	// A held watch outlives nothing: once whoever ran it is gone, it ends, so a failed test leaves no process behind.
	const parent = process.ppid;
	if (scenario.watchHold) setInterval(() => process.ppid !== parent && process.exit(0), 200);
} else {
	const delay = scenario.delayMs?.[command];
	if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
	// `project add` makes the project its arguments describe, as the CLI does, and `projects` lists it from then on,
	// unless the scenario gives its own reply.
	const added = `${process.env.FAKE_NEXUS}.projects`;
	const adds = existsSync(added) ? readFileSync(added, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
	let reply = command === "projects" && adds.length > 0 ? [...(responses.projects ?? []), ...adds] : responses[command];
	if (command === "project" && argv[1] === "add" && reply === undefined) {
		const [id, repoUrl] = argv.slice(2).filter((arg) => !arg.startsWith("--"));
		const flag = (name) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
		reply = { id, repoUrl, defaultBranch: flag("branch") ?? "main", defaultNode: flag("node"), resources: { cpus: 2, memoryGiB: 4, diskGiB: 20 }, allowedHosts: [], secrets: [], logins: [], preSetup: null };
		appendFileSync(added, `${JSON.stringify(reply)}\n`);
	}
	process.stdout.write(`${JSON.stringify(reply ?? null, null, 2)}\n`);
	appendFileSync(answered, `${command}\n`);
}
