/**
 * The project whose threads the console's picker, the strip and the status line show, or every project. It is kept
 * in the settings, so later sessions keep it, and the start form starts from it. The model's tools never read it.
 */
import type { Project, Thread } from "./contract.ts";
import type { SettingsStore } from "./store.ts";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The scope as the picker's header names it. */
export const scopeLabel = (project: string | null) => project ?? "All projects";

export const inScope = <T extends Thread>(threads: readonly T[], project: string | null): T[] =>
	project === null ? [...threads] : threads.filter((t) => t.project === project);

export class Scope {
	private current: string | null;

	constructor(
		private readonly settings: SettingsStore,
		private readonly say: (message: string, level: "info" | "warning") => void,
		/** Shows the strip and the status line again, from the threads last listed. */
		private readonly changed: () => void,
	) {
		this.current = settings.read().project;
	}

	get project(): string | null {
		return this.current;
	}

	/** Shows `project`, or every project for null, in this session and later ones. */
	set(project: string | null): void {
		this.current = project;
		try {
			this.settings.update({ project });
		} catch (err) {
			this.say(`Nexus shows ${project === null ? "every project" : `the project ${project}`} in this session only, since the setting could not be saved: ${errorText(err)}`, "warning");
		}
		this.changed();
	}

	/**
	 * Goes back to every project, saying so, when the project shown is not among `projects`, as after it was deleted.
	 * Saving that makes the notice a one-time one. `asked` is the project shown when the list was asked for: a list
	 * read before another project was chosen, or added, cannot tell whether that one exists.
	 */
	check(projects: readonly Project[], asked: string | null): void {
		const gone = this.current;
		if (gone === null || gone !== asked || projects.some((p) => p.id === gone)) return;
		this.set(null);
		this.say(`The project ${gone} no longer exists, so Nexus shows every project again.`, "warning");
	}
}
