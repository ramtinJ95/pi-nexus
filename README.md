# pi-nexus

Drive [Nexus](https://github.com/ramtinJ95/nexus) threads from [Pi](https://github.com/earendil-works/pi-mono).

Nexus runs coding agents in per-thread VMs, called pylons, on home-lab nodes. `@ramtinj95/pi-nexus` lets you list, start, message, watch and manage those threads from a Pi session instead of the dashboard. It also gives Pi's model tools to start a thread, message it and wait for its reply.

The extension talks to Nexus only through the `nexus` CLI, run as a child process with `--json`. The CLI owns the control plane's URL and proxy, so this package has no network configuration of its own. The CLI's contract is `docs/cli.md` in the Nexus repository.

## Install

Install the `nexus` CLI on this Mac first and check that `nexus threads` works. pi-nexus 0.3.0 needs a Nexus control plane and CLI at or after [nexus#36](https://github.com/ramtinJ95/nexus/pull/36), which stream a thread's conversation and report its ports and preview URLs. With an older one, a reply without the new fields, such as `show` or a watch's `state`, fails as a contract error that names the missing field. Unpublishing a preview needs CLI 0.3.0, from [nexus#39](https://github.com/ramtinJ95/nexus/pull/39) or later, which adds `nexus unpreview`. An older CLI fails an unpublish with a message to update it. Then:

```bash
pi install npm:@ramtinj95/pi-nexus
```

Run `/reload` or restart Pi after installation. Pi packages execute with full system access, so review extensions before installing them.

The extension runs `nexus` from `PATH`. Set `NEXUS_BIN` to run another binary.

## The console

`/nexus` opens the thread picker, and `/nexus open <thread>` opens a thread as a pi session. Together they do what the Nexus web dashboard does.

- **Picker.** Threads are grouped by project, open ones first. Each project's archived and deleted threads fold under one row, and Enter unfolds them. Each row shows the dashboard's overview: what the thread is doing, the wanted and observed pylon state, the node, the last human and agent activity, and how long ago it was active. Narrow terminals drop columns from the right. Typing filters by title or ID, `ctrl+n` starts a thread, and Esc clears the filter and then closes.
- **Thread view.** The thread fills the screen and draws its conversation with pi's own components, so it reads exactly like a pi transcript: markdown prose, tool calls with their output, edit diffs, failed commands with their exit codes. Four or more tool calls in a row fold into one line, which opens by itself when a step failed or is running. `ctrl+o` expands everything, as in pi. While the agent works, the editor's top border shows the run's clock and its tool count. An answer streams in as the agent writes it, redrawn at most ten times a second, and the view keeps to its end. Messages waiting for the run show above the editor. `PgUp` and `PgDn` scroll, and a view scrolled up stays put while the answer goes on. A dim line under the footer lists the keys that work, as pi's own hint line does.
- **Composer.** Enter sends a message, or queues it while the run is busy. A send that failed is put back in the editor, and sending the same text again reuses its request ID, so Nexus never takes it twice. `/steer <text>` joins the current run instead. The other slash commands are `/abort`, `/retry` for parked tasks, `/retry-pylon`, `/start-again`, `/archive`, `/unarchive`, `/delete` (it asks, with Keep first), `/open <port>`, `/unpublish <port>`, `/copy <port or service>`, `/info` and `/close`. A slash the view does not know is sent as a message, as pi does.
- **States.** A parked run, a failed pylon with its diagnostic and what to do, an archived thread, a deleted one and a paused pylon each show a note above the editor. A thread that cannot take messages refuses them and says why.
- **Inspector.** `alt+i` or `/info` shows the pylon's wanted and observed state, node, last seen, and human and agent activity. It also shows the previews as links, with the port each one serves, and the ports that listen with no preview yet, each port once. `/open <port>` publishes a port as a preview, shows it opening while the node gets its URL ready, then links it, or says why it failed. A preview stays published until `/unpublish <port>` closes it: the preview shows closing while the CLI wakes a paused pylon and unpublishes it, then the port is back under Ports, or the preview says why it did not close. Only a port's own preview, named `port-<port>`, shows that hint, since the CLI refuses to unpublish a declared or ad hoc service's preview. A link opens on a click, and `/copy` puts it on the clipboard. When nothing listens, it reminds you that a server bound only to `::1` cannot be previewed. Then come the outputs, the sessions and the attach command. Esc goes back to the transcript.
- **Start form.** `/nexus new` or `/nexus new <project>` opens a form for the title, project, node, branch and first message. Empty node and branch mean the project's defaults. `/start-again` in a thread opens it with that thread's project and title.

Esc closes the view and never aborts the agent. Opening a thread counts as a visit, as on the dashboard, so a paused pylon wakes. The view gets everything through the CLI: `threads`, `projects`, `nodes`, `show`, `watch`, `preview`, `unpreview` and the action commands. Without nodes, the start form leaves out node choices, with a note saying why. Without pi's custom UI, as in RPC mode, `/nexus` lists the threads as a note, and `/nexus open` shows the conversation's tail.

## Commands

| Command | What it does |
| --- | --- |
| `/nexus` | Opens the thread picker |
| `/nexus open <thread>` | Opens the thread view |
| `/nexus new [project]` | Opens the start form |
| `/nexus list [project]` | Lists threads without deleted ones, as a note: ID, status, whether the agent is working, project and title |
| `/nexus new <project> [--title T] <message>` | Starts a thread with a first message, then follows it |
| `/nexus send <thread> <text>` | Sends a message, then follows the thread. A busy agent takes it after its current turn |
| `/nexus show <thread>` | Shows the thread's state and the tail of its conversation |
| `/nexus follow <thread>` | Streams new conversation entries into the session until the next turn ends |
| `/nexus unfollow [thread]` | Stops one follow, or all of them |
| `/nexus archive <thread>`, `unarchive` | Archives a thread, which pauses its pylon, or brings it back |
| `/nexus retry <thread>` | Runs a conversation's parked tasks again |
| `/nexus retry-pylon <thread>` | Clears a failed pylon so that Nexus boots it again |
| `/nexus abort <thread>` | Aborts the agent's current run |
| `/nexus unpublish <thread> <port>` | Unpublishes the port's preview, so its URL stops answering. A port with no preview is already unpublished, and a service's preview is refused. Publishing the port again may give it a new URL |
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
| `nexus_read` | `thread` | `{thread, status, run, pylon, queued, failed?, ports, conversation}`, with the conversation's last 6000 characters. `ports` lists `{port, service?, url?, ready?}` for each port that listens, with its preview's URL once it has one, or is null when the node could not read them |
| `nexus_wait` | `thread`, `timeout_seconds?` (1 to 600, default 300) | `{thread, settled, timed_out?, cancelled?, status, run, pylon, queued, failed?, ports, outage?, needs_human?, reply}`. `reply` is the assistant's text since the latest user message, its last 4000 characters, or null. `needs_human` tells the model when parked tasks or a failed pylon need `/nexus retry` or `/nexus retry-pylon` |
| `nexus_preview` | `thread`, `port` (1 to 65535) | `{thread, port, url, ready}`, once the node serves the URL, up to 2 minutes. The preview is open to the home tailnet until it is unpublished with `nexus_unpublish` or `/unpublish` |
| `nexus_unpublish` | `thread`, `port` (1 to 65535) | `{thread, port, unpublished: true}`, once the preview is closed, up to 2 minutes while a paused pylon wakes. A port with no preview succeeds too. A declared or ad hoc service's preview fails with the CLI's refusal. Publishing the port again may give it a new URL |
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

`npm run check` type-checks, runs the tests, and verifies the npm package contents. The tests drive the tools, commands and console against a fake `nexus` binary that prints contract-shaped JSON, and `test/pi-rpc.test.ts` loads the extension into a real Pi in RPC mode.

`test/demo/` builds the console's screenshot demo. `bun test/demo/build.ts <dir>` writes a fake `nexus` whose thread holds one scripted conversation. `test/demo/faux-model.ts` is a pi extension whose model plays the same conversation, so a real pi session can be put beside the thread view.

To try a local checkout against the real control plane:

```bash
pi -e ./extensions/nexus/index.ts
```

## License

MIT
