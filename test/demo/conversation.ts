/**
 * One conversation for the side-by-side screenshots: a real pi session plays it through a scripted model, and the
 * fake nexus serves the same messages as a thread's entries. Prose, a read, an edit, a failed command, and a
 * command still running with a follow-up queued behind it.
 */
export const prompt = "Fix the retry in probe.ts so it backs off.";
export const followUp = "also update the docs";
export const model = "demo-model";

export const probe = "export async function probe(url: string) {\n\tawait sleep(1000);\n\treturn fetch(url);\n}\n";

/** The suite fails on its first run and passes slowly on its second, so the second is still running when captured. */
export const testScript = `#!/bin/sh
if [ "$1" = "--bail" ]; then
  echo "> probe.test.ts"
  echo "  ✓ backs off"
  sleep 600
fi
echo "FAIL probe.test.ts"
echo "  expected a delay of 1000"
exit 1
`;

type Call = { id: string; name: string; arguments: Record<string, unknown> };
export interface Step {
	text?: string;
	call: Call;
}

export const steps: Step[] = [
	{ text: "I'll read the **probe** first.", call: { id: "call-read", name: "read", arguments: { path: "src/probe.ts" } } },
	{
		text: "The retry waits a fixed second. I'll make it back off.",
		call: { id: "call-edit", name: "edit", arguments: { path: "src/probe.ts", edits: [{ oldText: "\tawait sleep(1000);", newText: "\tawait sleep(backoff(attempt));" }] } },
	},
	{ call: { id: "call-test", name: "bash", arguments: { command: "./test.sh" } } },
	{ text: "One test still expects the old delay. I'll update it and run the suite again.", call: { id: "call-again", name: "bash", arguments: { command: "./test.sh --bail" } } },
];

/** The running command's output so far, as the live run reports it. */
export const runningOutput = "> probe.test.ts\n  ✓ backs off";
