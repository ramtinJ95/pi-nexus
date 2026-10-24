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

`/nexus` opens the thread whose agent is working, the most recently active one first, with the thread picker under it. With no agent working it opens the picker. `/nexus open <thread>` opens one thread. Together they do what the Nexus web dashboard does.

The console reads keys as vim does, and pi's arrow keys work beside them. A thread view opens in normal mode, where keys move through the view; `i` or `a` enters insert mode, where every key goes to the composer as in pi, and Esc or an empty Enter returns to normal mode. The line of key hints under the footer starts with the mode, `NORMAL` or `INSERT`, or `FILTER` while the picker filters, and the composer shows its cursor and pi's border colour only in insert mode. `s` or `?` lists every key. The keys match the Nexus mod for Claude Code, which reads only single letters, so pi adds vim's own keys beside them, such as `G`, `ctrl+d` and `gt`.

| Keys | Thread view, normal mode |
| --- | --- |
| `i`, `a` | Write a message. Esc stops writing and keeps the draft |
| `/` | Type a slash command, such as `/open 8080` |
| `j` `k`, `↓` `↑` | Scroll a line, or select the next or previous port in Ports |
| `d` `u`, `ctrl+d` `ctrl+u`, `PgDn` `PgUp` | Scroll half a page, or a page |
| `gg` `ge` `G`, `Home` `End` | The top, or the end, which then follows the agent. The first or last port in Ports |
| `h` `l`, `←` `→` | The view to the left or right. `h` on Conversation goes back to the thread or picker you came from |
| `gt` `gT`, `Tab`, `1` `2` `3` | Cycle through, or jump to, Conversation, Details and Ports |
| `Enter`, `o` | In Ports, publish the selected port |
| `x` | In Ports, unpublish the selected port's own preview |
| `y` | Copy the selected preview's link in Ports, or the attach command in Details |
| `m`, `:` | The thread's actions |
| `r` | Read the thread's details again |
| `t` | The thread picker, to switch threads |
| `q` | Close the console |
| `Esc` | Back to Conversation |
| `ctrl+o` | Expand or fold tool output, as in pi, whichever key you bound to it |

- **Picker.** Threads are grouped by project, open ones first. Each project's archived and deleted threads fold under one row, and Enter unfolds them. Each row shows the dashboard's overview: what the thread is doing, the wanted and observed pylon state, the node, the last human and agent activity, and how long ago it was active. A thread whose pylon failed, or whose tasks were parked when the console or a follow last saw it, says `needs you`, and one whose agent did something since you last looked at it says `new`. The threads list does not report parked tasks, so pi-nexus knows them only for threads it has watched, as the Claude Code mod does; the marker stays until the agent does something after that, such as running the retried tasks. Narrow terminals drop columns from the right. `j` and `k` move, `d` and `u` move half a page, `gg` and `ge` or `G` jump, Enter, `o` or `l` opens, `n` or `ctrl+n` starts a thread, `r` reads the threads again, and `f` or `/` filters by title or ID: Enter keeps the filter and Esc clears it. Esc clears a filter, then goes back, and `q` closes the console.
- **Going back.** The console keeps the way you came. Opening a thread from the picker, or from a thread's picker with `t`, goes forward, and `h` on Conversation, or Esc in the picker, returns to the thread or picker before it. A thread opened from a thread's picker replaces that picker, so `h` goes straight back to the first thread.
- **Conversation.** The thread fills the screen and draws its conversation with pi's own components, so it reads exactly like a pi transcript: markdown prose, tool calls with their output, edit diffs, failed commands with their exit codes. Four or more tool calls in a row fold into one line, which opens by itself when a step failed or is running. While the agent works, the editor's top border shows the run's clock and its tool count. An answer streams in as the agent writes it, redrawn at most ten times a second, and the view keeps to its end. Messages waiting for the run show above the editor. A view scrolled up stays put while the answer goes on, until `G` follows the end again.
- **Composer.** Enter sends a message, or queues it while the run is busy, and insert mode lasts past a send. An unsent message stays with its thread while you move between views, such as to the picker and back. A send that failed is put back in the editor, and sending the same text again reuses its request ID, so Nexus never takes it twice. `/steer <text>` joins the current run instead. The other slash commands are `/abort`, `/retry` for parked tasks, `/retry-pylon`, `/start-again`, `/archive`, `/unarchive`, `/delete` (it asks, with Keep first), `/open <port>`, `/unpublish <port>`, `/copy <port or service>`, `/info` and `/close`. A slash the view does not know is sent as a message, as pi does.
- **Actions.** `m` lists the actions that apply to the thread now: watch again after the watch ended, abort the run, retry the parked tasks, retry the pylon, start again, archive or unarchive, copy the attach command, and delete, which asks with Keep first. `j` and `k` move, Enter runs one, and Esc cancels.
- **States.** A parked run, a failed pylon with its diagnostic and what to do, an archived thread, a deleted one and a paused pylon each show a note above the editor. A thread that cannot take messages refuses them and says why.
- **Details.** `2` or `/info` shows the pylon's wanted and observed state, node, last seen, and human and agent activity, then the outputs, the sessions and the attach command.
- **Ports.** `3` shows the previews as links, with the port each one serves, and the ports that listen with no preview yet, each port once. `j` and `k` select a row, and its hint names the key that acts on it. Enter on a port with no preview, or `/open <port>`, publishes it as a preview, shows it opening while the node gets its URL ready, then links it, or says why it failed. A preview stays published until `x` on its row or `/unpublish <port>` closes it: the preview shows closing while the CLI wakes a paused pylon and unpublishes it, then the port is back under Ports, or the preview says why it did not close. While a port is being published or unpublished, from the console, a `/nexus` command or a model tool, any other change of that port is refused until it finishes, so an older publish can never undo a newer unpublish. Only a port's own preview, named `port-<port>`, can be unpublished, since the CLI refuses to unpublish a declared or ad hoc service's preview. A link opens on a click, and `y` or `/copy` puts it on the clipboard. When nothing listens, it reminds you that a server bound only to `::1` cannot be previewed.
- **Start form.** `/nexus new`, `/nexus new <project>` or `n` in the picker opens a form for the title, project, node, branch and first message. Empty node and branch mean the project's defaults. Start again opens it with the thread's project and title, and cancelling it goes back to the thread.
- **Strip.** From the session's start, one line above pi's editor names the threads that need you, then those with a new reply since you last looked, then those whose agent works, with how long ago the message it answers came. pi's status line keeps the counts: `nexus 1 working · 1 needs you · 1 new`. Both come from one poll of `nexus threads` every 30 seconds and after each command. `/nexus strip off` hides both and stops the polling, and `/nexus strip on` starts it again. The setting is kept in `pi-nexus/settings.json` in pi's agent directory, so later sessions keep it. pi's RPC mode shows the status line but cannot draw the strip.

Leaving a view never aborts the agent. Opening a thread counts as a visit, as on the dashboard, so a paused pylon wakes. When you last looked at each thread is kept in `pi-nexus/viewed.json` in pi's agent directory, so every pi session on this Mac shares it; a thread nobody has looked at counts its agent's activity from when that file was first written. Each poll drops the looks at deleted threads. The view gets everything through the CLI: `threads`, `projects`, `nodes`, `show`, `watch`, `preview`, `unpreview` and the action commands. Without nodes, the start form leaves out node choices, with a note saying why. Without pi's custom UI, as in RPC mode, `/nexus` lists the threads as a note, and `/nexus open` shows the conversation's tail.

## Commands

| Command | What it does |
| --- | --- |
| `/nexus` | Opens the working thread with the picker under it, or the picker |
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
| `/nexus strip on`, `off` | Shows or hides, for this and later sessions, the strip of threads that need you, have news or work above the editor |
| `/nexus help` | Lists these commands |

A thread is its ID, such as `th-0123456789ab`, or any unique prefix of it, with or without `th-`. Tab completes command names and the thread IDs last listed.

Conversation text appears in the chat as Nexus notes. Pi stores the notes in the session but never sends them to its model. A collapsed note shows its last 16 lines, and `ctrl+o` expands it.

A follow ends when the thread settles as `nexus_wait` judges it, failed pylons included, or with `/nexus unfollow`. After `/nexus new` or `/nexus send`, a reply that arrived before the first poll counts. `/nexus follow` on an idle thread waits for its next turn. A widget above the editor shows each follow's state while it runs. A follow keeps going through a control plane outage and says so in the chat.

While the strip setting is on, which it is unless `/nexus strip off` turned it off, the status line shows from the session's start how many threads have a working agent, and how many need you or have something new since you last looked, such as `nexus 2 working · 1 needs you · 3 new`. It refreshes every 30 seconds and after each command. When the CLI cannot reach Nexus, it shows the failure kind instead, such as `nexus unreachable`.

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

`test/demo/` builds the console's screenshot demo. `bun test/demo/build.ts <dir>` writes a fake `nexus` whose working thread holds one scripted conversation, beside a thread with a new answer, one whose pylon failed and an archived one, and a pi agent directory whose looks store marks them. `test/demo/faux-model.ts` is a pi extension whose model plays the same conversation, so a real pi session can be put beside the thread view. To see the console against it:

```bash
repo=$PWD; bun test/demo/build.ts /tmp/demo
cd /tmp/demo/work && PI_CODING_AGENT_DIR=/tmp/demo/agent NEXUS_BIN=/tmp/demo/nexus PI_OFFLINE=1 \
  pi --no-session -ne -ns -np -nc --no-mcp -e "$repo/extensions/nexus/index.ts" -e "$repo/test/demo/faux-model.ts" --model demo/demo-model
```

Then `/nexus`. For a screenshot, read the pane with its colours, such as `tmux capture-pane -ep`, pass it through `bun test/demo/carry-sgr.ts`, and render it with `freeze --language ansi`.

To try a local checkout against the real control plane:

```bash
pi -e ./extensions/nexus/index.ts
```

## License

MIT
