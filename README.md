# pi-nexus

Drive [Nexus](https://github.com/ramtinJ95/nexus) threads from [Pi](https://github.com/earendil-works/pi-mono).

Nexus runs coding agents in per-thread VMs, called pylons, on home-lab nodes. `@ramtinj95/pi-nexus` lets you list, start, message, watch and manage those threads from a Pi session instead of the dashboard. It also gives Pi's model tools to start a thread, message it and wait for its reply.

The extension talks to Nexus only through the `nexus` CLI, run as a child process with `--json`. The CLI owns the control plane's URL and proxy, so this package has no network configuration of its own. The CLI's contract is `docs/cli.md` in the Nexus repository.

## Install

Install the `nexus` CLI on this Mac first and check that `nexus threads` works. Then:

```bash
pi install npm:@ramtinj95/pi-nexus
```

Run `/reload` or restart Pi after installation. Pi packages execute with full system access, so review extensions before installing them.

The extension runs `nexus` from `PATH`. Set `NEXUS_BIN` to run another binary.

## Commands

| Command | What it does |
| --- | --- |
| `/nexus` or `/nexus list [project]` | Lists threads without deleted ones: ID, status, whether the agent is working, project and title |
| `/nexus new <project> [--title T] <message>` | Starts a thread with a first message, then follows it |
| `/nexus send <thread> <text>` | Sends a message, then follows the thread. A busy agent takes it after its current turn |
| `/nexus show <thread>` | Shows the thread's state and the tail of its conversation |
| `/nexus follow <thread>` | Streams new conversation entries into the session until the next turn ends |
| `/nexus unfollow [thread]` | Stops one follow, or all of them |
| `/nexus archive <thread>`, `unarchive` | Archives a thread, which pauses its pylon, or brings it back |
| `/nexus retry <thread>` | Runs a conversation's parked tasks again |
| `/nexus retry-pylon <thread>` | Clears a failed pylon so that Nexus boots it again |
| `/nexus abort <thread>` | Aborts the agent's current run |
| `/nexus delete <thread>` | Deletes a thread and its pylon once you pick Delete. Keep is the highlighted answer, and dismissing the dialog keeps the thread |
| `/nexus help` | Lists these commands |

A thread is its ID, such as `th-0123456789ab`, or any unique prefix of it, with or without `th-`. Tab completes command names and the thread IDs last listed.

Conversation text appears in the chat as Nexus notes. Pi stores the notes in the session but never sends them to its model. A collapsed note shows its last 16 lines, and `ctrl+o` expands it.

A follow ends when the thread settles as `nexus_wait` judges it, failed pylons included, or with `/nexus unfollow`. After `/nexus new` or `/nexus send`, a reply that arrived before the first poll counts. `/nexus follow` on an idle thread waits for its next turn. A widget above the editor shows each follow's state while it runs. A follow keeps going through a control plane outage and says so in the chat.

Once you use a `/nexus` command or the model calls a Nexus tool, the status line shows how many threads have a working agent, such as `nexus 2 working`. It refreshes every 30 seconds and after each command. When the CLI cannot reach Nexus, it shows the failure kind instead, such as `nexus unreachable`.

Every failure is shown as an error notification with the CLI's message. When the SOCKS proxy is down, that message points to `ts-home status`.

## Model tools

| Tool | Parameters | Result |
| --- | --- | --- |
| `nexus_threads` | `project?` | `[{id, project, title, status, working, active}]`, without deleted threads. `active` reads like `2m ago` |
| `nexus_start` | `project`, `message`, `title?` | `{id, project, title}`. The title defaults to the message's first line |
| `nexus_send` | `thread`, `text` | `{thread, sent: true}`. A working agent takes the message after its current turn |
| `nexus_read` | `thread` | `{thread, status, run, pylon, queued, failed?, conversation}`, with the conversation's last 6000 characters |
| `nexus_wait` | `thread`, `timeout_seconds?` (1 to 600, default 300) | `{thread, settled, timed_out?, cancelled?, status, run, pylon, queued, failed?, outage?, needs_human?, reply}`. `reply` is the assistant's text since the latest user message, its last 4000 characters, or null. `needs_human` tells the model when parked tasks or a failed pylon need `/nexus retry` or `/nexus retry-pylon` |
| `nexus_archive` | `thread` | `{thread, status: "archived"}` |

Results are compact JSON. A failure is a failed tool call whose text reads `nexus (<kind>): <the CLI's message>`, where the kind is the CLI's, such as `unreachable` or `not-found`.

`nexus_wait` counts a thread as settled at once when it cannot run on: archived, deleted, parked, or its pylon failed. Otherwise its run must be idle with nothing queued, and either the agent has answered the latest message or this wait saw the run working, which covers a turn aborted before it wrote anything. A settling state ends the wait at once, and an entry that looks settled counts after a quiet second. It reads one `nexus watch` and stops it when done. Outages are waited through and reported in `outage`. `reply` joins every assistant text since the latest user message, a blank line apart, and is null when that turn wrote none.

The model cannot delete a thread, retry a pylon or retry parked tasks. Those stay human-only, as `/nexus delete`, `/nexus retry-pylon` and `/nexus retry`.

These tools match the Claude Code Nexus mod in parameters, results and the wait rule. Only the names differ: the mod's tools show as `mcp__nexus__threads` and so on, because Claude Code namespaces them, and pi does not.

## Development

```bash
npm install
npm run check
```

`npm run check` type-checks, runs the tests, and verifies the npm package contents. The tests drive the tools and commands against a fake `nexus` binary that prints contract-shaped JSON, and `test/pi-rpc.test.ts` loads the extension into a real Pi in RPC mode.

To try a local checkout against the real control plane:

```bash
pi -e ./extensions/nexus/index.ts
```

## License

MIT
