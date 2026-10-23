import { watchView, type Nexus } from "./cli.ts";
import type { Note } from "./render.ts";
import { isSettled, transcript, type ThreadView } from "./thread.ts";

export interface FollowSink {
	note(note: Note): void;
	state(view: ThreadView): void;
}

export type FollowEnd = "answered" | "parked" | "failed" | "archived" | "deleted" | "stopped";

const contextEntries = 3;

/** Why a settled view settled. */
function endOf({ state }: ThreadView): FollowEnd {
	if (state?.status === "deleted" || state?.status === "archived") return state.status;
	if (state?.run === "parked") return "parked";
	return state?.pylon === "failed" || state?.failed ? "failed" : "answered";
}

/**
 * Streams a thread's new entries until it settles, as nexus_wait judges it, or `signal` aborts. With `nextTurn`, a
 * thread already answered when the follow starts does not count, so a follow of an idle thread waits for its next
 * turn. Without it, as after a send, a reply that came before the first poll ends the follow.
 */
export async function follow(nexus: Nexus, thread: string, sink: FollowSink, signal: AbortSignal, nextTurn: boolean): Promise<FollowEnd> {
	let first = true;
	let active = !nextTurn;
	const { view, checked } = await watchView(
		nexus,
		thread,
		{
			event(event, view) {
				switch (event.type) {
					case "reset": {
						// A later reset means the context changed, which only a turn or a compaction does.
						if (!first) active = true;
						const shown = first ? view.entries.filter((e) => e.text !== "").slice(-contextEntries) : view.entries;
						sink.note({ title: first ? `following ${thread}` : `${thread} conversation was rewritten`, body: transcript(shown, 20_000) });
						first = false;
						break;
					}
					case "entry":
						active = true;
						if (event.text !== "") sink.note({ title: thread, body: event.text });
						break;
					case "error":
						sink.note({ title: thread, body: `${view.outage} Still watching.`, error: true });
						sink.state(view);
						break;
					case "state":
						if (event.run !== "idle" || event.queued > 0) active = true;
						sink.state(view);
						break;
				}
			},
			check: (view) => isSettled(view) && (active || endOf(view) !== "answered"),
		},
		signal,
	);
	return checked || view.state?.status === "deleted" ? endOf(view) : "stopped";
}
