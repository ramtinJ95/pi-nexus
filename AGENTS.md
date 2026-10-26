# Agent guide

This repository is the canonical source for `@ramtinj95/pi-nexus`.

- Reach Nexus only through the `nexus` CLI as a child process. Never import the Nexus repository's code, and never hardcode a control plane URL or proxy; the CLI owns both. Its contract is `docs/cli.md` in the Nexus repository.
- Every shape the CLI prints is a TypeBox schema in `extensions/nexus/contract.ts`, and its type derives from that schema with `Static<>`. `cli.ts` parses each reply through its schema; never cast a CLI reply. To read a new field, declare it in the schema first.
- The model must never get a tool that deletes a thread, retries a pylon or parked tasks, or manages sessions. Those stay `/nexus` commands for the human. Project creation is allowed, but its only secret grant is `github: true`: `GH_TOKEN` to `api.github.com,github.com`. Never accept free-form secret names or secret hosts.
- Keep the tools' parameters, results and wait rule identical to the Claude Code Nexus mod (claude-mods, plugins/nexus/hooks/tools.ts and model.ts); only the `nexus_` name prefix differs. Change both together.
- Register every `nexus_*` tool with deferred exposure, falling back to direct when pi's builtin `tool_search` is missing, replaced or inactive. Keep names and descriptions searchable by Nexus, thread, pylon and project.
- Nexus notes are custom entries, so they never reach the model. Keep them that way.
- The console (`extensions/nexus/console/`) follows the web dashboard, `src/control/dashboard.ts` in the Nexus repository: its state labels, folds, run bar, composer states and inspector. It draws a thread's conversation with pi's own message components and tool renderers, and everything else with pi-tui components and theme tokens. Never use raw colours; a test checks the console's sources for them.
- Never mark a tool call's arguments complete or its execution started in the console. Either would make pi's renderers read this machine's files at the pylon's paths, or start timers the view cannot stop.
- Thread tabs are Conversation, Changes, Previews and Pylon; sessions live under Pylon. Changes needs Nexus CLI 0.6.0. Opening a thread still records its visit with `nexus wake`, independently of checkout reads; Changes waits for running before its first read. Checkout reads wake pylons: never poll them or read a non-running pylon without explicit wake-and-read consent. Keep the serialized, cancellable reader in `console/changes.ts`, and persist the Changes base (`c` for uncommitted, `T` for the latest turn) with the console settings.
- Claude worker threads read their transcript with `nexus conversation`, as the Claude Code mod does, never a watch, which streams it only since CLI 0.19.0; read it only while Claude works or when the details or a send say it changed. Seen marks go through `nexus seen`; never keep a seen store of our own.
- Run `npm run check` after changes; it type-checks, tests, and verifies the npm package contents.
