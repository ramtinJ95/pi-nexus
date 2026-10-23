# Agent guide

This repository is the canonical source for `@ramtinj95/pi-nexus`.

- Reach Nexus only through the `nexus` CLI as a child process. Never import the Nexus repository's code, and never hardcode a control plane URL or proxy; the CLI owns both. Its contract is `docs/cli.md` in the Nexus repository.
- The model must never get a tool that deletes a thread or retries a pylon. Those stay `/nexus` commands for the human.
- Keep the tools' parameters, results and wait rule identical to the Claude Code Nexus mod (claude-mods, plugins/nexus/hooks/tools.ts and model.ts); only the `nexus_` name prefix differs. Change both together.
- Nexus notes are custom entries, so they never reach the model. Keep them that way.
- Run `npm run check` after changes; it type-checks, tests, and verifies the npm package contents.
