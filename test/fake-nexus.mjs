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
	process.stdout.write(`${JSON.stringify(responses[command] ?? null, null, 2)}\n`);
	appendFileSync(answered, `${command}\n`);
}
