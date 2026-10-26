# pi-nexus

Drive [Nexus](https://github.com/ramtinJ95/nexus) threads from [Pi](https://github.com/earendil-works/pi-mono).

Nexus runs coding agents in per-thread VMs, called pylons, on home-lab nodes. `@ramtinj95/pi-nexus` lets you list, start, message, watch and manage those threads from a Pi session instead of the dashboard. It also gives Pi's model tools to start a thread, message it and wait for its reply.

The extension talks to Nexus only through the `nexus` CLI, run as a child process with `--json`. The CLI owns the control plane's URL and proxy, so this package has no network configuration of its own. The CLI's contract is `docs/cli.md` in the Nexus repository.

## Install

pi-nexus 0.10.0 needs a Nexus control plane and CLI at 0.10.0 or later, whose threads carry the shared `seenAt`, `lastReplyAt` and `attention`; with a CLI older than 0.10.0, `threads` and `show` fail naming the version they need, and with a newer CLI but an older control plane, as a contract error that names `seenAt`. Marking a reply seen needs CLI 0.10.0 (`nexus seen`), Changes' latest turn needs CLI 0.11.0 (`--turn`), and a Claude worker thread's transcript needs CLI 0.17.0 (`nexus conversation`); an older CLI is refused before each runs, with the version it needs. Changes in pi-nexus 0.8.0 needs Nexus CLI 0.6.0 or later (`nexus changes` and `nexus diff`). Install the `nexus` CLI on this Mac first and check that `nexus threads` works. pi-nexus 0.4.0 needs a Nexus control plane and CLI at or after [nexus#36](https://github.com/ramtinJ95/nexus/pull/36), which stream a thread's conversation and report its ports and preview URLs. With an older one, a reply without the new fields, such as `show` or a watch's `state`, fails as a contract error that names the missing field. Unpublishing a preview needs CLI 0.3.0, from [nexus#39](https://github.com/ramtinJ95/nexus/pull/39) or later, which adds `nexus unpreview`. An older CLI fails an unpublish with a message to update it. Adding a project needs CLI 0.4.0 or later, which adds `nexus project add`. An older CLI fails an add with a message to update it, and choosing which project shows works with any. Opening and closing sessions need CLI 0.5.0 or later, from [nexus#44](https://github.com/ramtinJ95/nexus/pull/44), which adds `nexus session open`, `nexus session close` and `nexus attach`, and sessions' titles. An older CLI fails each with a message to update it, and an older control plane's sessions show without titles. Attaching needs CLI 0.9.0 or later, which attaches through the control plane. An older CLI attaches over ssh, which upgraded nodes refuse, so pi-nexus refuses the attach before it runs and names the version it needs. A paused pylon's sessions, and those its last wake failed to bring back, show with a control plane and CLI at 0.8.0 or later, which list them as paused or failed and close a session by its ID. An older control plane lists only the sessions running in panes, as before. Closing a session needs CLI 0.8.0 or later, which passes on the refusal to close a paused session at once. With an older CLI, which would ask again for two minutes and close the session unasked if a wake came meanwhile, pi-nexus refuses the close before it runs and names the version it needs. A preview whose service failed shows as failed only with a control plane that reports a preview's `failed`; an older one shows it starting. A control plane with scratch projects, from CLI 0.7.0 and [nexus#46](https://github.com/ramtinJ95/nexus/pull/46), lists a scratch project with no repo URL. pi-nexus 0.5.2 or later shows it as `scratch`; an older pi-nexus fails everything that reads the projects, such as the project picker and `/nexus project`, with a contract error about `repoUrl`. Then:

```bash
pi install npm:@ramtinj95/pi-nexus
```

Run `/reload` or restart Pi after installation. Pi packages execute with full system access, so review extensions before installing them.

The extension runs `nexus` from `PATH`. Set `NEXUS_BIN` to run another binary, which the attach command it shows and copies names too.

## The console

`/nexus` opens the thread whose agent is working, the most recently active one first, with the thread picker under it. With no agent working it opens the picker. `/nexus open <thread>` opens one thread. Together they do what the Nexus web dashboard does.

The console reads keys as vim does, and pi's arrow keys work beside them. A thread view opens in normal mode, where keys move through the view; `i` or `a` enters insert mode, where every key goes to the composer as in pi, and Esc or an empty Enter returns to normal mode. The line of key hints under the footer starts with the mode, `NORMAL` or `INSERT`, or `FILTER` while the picker filters, and the composer shows its cursor and pi's border colour only in insert mode. `s` or `?` lists every key. The keys match the Nexus mod for Claude Code, which reads only single letters, so pi adds vim's own keys beside them, such as `G`, `ctrl+d` and `gt`.

| Keys | Thread view, normal mode |
| --- | --- |
| `i`, `a` | Write a message. Esc stops writing and keeps the draft |
| `/` | Type a slash command, such as `/open 8080` |
| `j` `k`, `↓` `↑` | Scroll a line, or select the next or previous row in Changes, Previews and Pylon |
| `d` `u`, `ctrl+d` `ctrl+u`, `PgDn` `PgUp` | Scroll half a page, or a page |
| `gg` `ge` `G`, `Home` `End` | The top, or the end, which then follows the agent. The first or last row in Changes, Previews and Pylon |
| `h` `l`, `←` `→` | The view to the left or right. `h` in a diff returns to its tree; on Conversation it goes back to the thread or picker you came from |
| `gt` `gT`, `Tab`, `1` `2` `3` `4` | Cycle through, or jump to, Conversation, Changes, Previews and Pylon |
| `Enter`, `o` | In Changes, fold a folder or open a file’s diff; on a paused pylon, wake and read. In Previews, publish the selected port. In Pylon, attach this terminal to the pylon's sessions |
| `x` | In Previews, unpublish the selected port's own preview. In Pylon, close the selected session, after asking |
| `n` | Open a session in the pylon: Claude Code, pi or a shell |
| `y` | Copy the file path in Changes, the preview link in Previews, or `nexus attach <thread>` in Pylon |
| `m`, `:` | The thread's actions |
| `r` | Read Changes again (waking the pylon if needed), or the thread's details in other views |
| `c` | In Changes, toggle only uncommitted changes; the choice persists between sessions |
| `T` | In Changes, toggle the latest turn's changes; the choice persists between sessions |
| `t` | The thread picker, to switch threads |
| `p` | The project picker, to choose the project whose threads show |
| `q` | Close the console |
| `Esc` | Back to the tree from a diff, otherwise Conversation |
| `ctrl+o` | Expand or fold tool output, as in pi, whichever key you bound to it |

- **Picker.** Threads are grouped by project, open ones first. Each project's archived and deleted threads fold under one row, and Enter unfolds them. Project headings show `▾ project  branch`, with the default branch dim. Each thread starts with its coloured status dot and title, and ends with a dim, right-aligned activity age. Where the width allows, rows keep the dashboard's overview: what the thread is doing, the wanted and observed pylon state, the node, the last human and agent activity, and how long ago it was active. The markers are the control plane's attention, which every client shares: a thread whose pylon or Claude worker failed, whose tasks are parked, or whose session waits for input says `needs you`, and one with a reply nobody has marked seen, in any client, says `new`. Parked tasks show for every thread, watched or not. Narrow terminals drop columns from the right. `j` and `k` move, `d` and `u` move half a page, `gg` and `ge` or `G` jump, Enter, `o` or `l` opens, `n` or `ctrl+n` starts a thread, `p` chooses the project, `r` reads the threads again, and `f` or `/` filters by title or ID: Enter keeps the filter and Esc clears it. Esc clears a filter, then goes back, and `q` closes the console.
- **Projects.** The picker shows one project's threads, or every project's, and its header names which: `Nexus threads · spoon` or `Nexus threads · All projects`. `p`, in the picker or a thread view's normal mode, opens the project picker: All projects, then each project with its repo URL, or `scratch` for a scratch project, whose threads start from an empty repository with no remote, then New project…, with the project shown now selected and marked `current`. `j` and `k` move, `gg` and `ge` or `G` jump, Enter or `o` chooses, and `q` or Esc goes back. Choosing a project shows its threads: the picker you came from, or from a thread a picker that switches from it, as `t` opens. The same choice scopes the strip and the status line's counts, which then name the project, such as `nexus spoon · 1 working`, and the start form opens on it. It is kept in `pi-nexus/settings.json` in pi's agent directory, beside the strip setting, so later sessions keep it. A project that no longer exists goes back to every project, with one notice. The model's `nexus_threads` is never scoped.
- **New project.** New project… opens a form for the ID, the repo URL, the node, which starts on the first online one, and the branch, `main` unless you type another. Tab and Shift+Tab move between fields, ←→ choose the node, Enter goes to the next field and adds the project from Branch, and Esc goes back to the project picker. It runs `nexus project add <id> <repo-url> --node <node> --branch <branch>`, and once the project is added the console shows its threads. A failure shows the CLI's own message, such as a project that exists already or an ID, URL or node that is not valid, and keeps the form filled. The console form adds only projects with a repo URL; `nexus project add <id> --scratch --node <node>` at a shell adds a scratch project.
- **Going back.** The console keeps the way you came. Opening a thread from the picker, or from a thread's picker with `t`, goes forward, and `h` on Conversation, or Esc in the picker, returns to the thread or picker before it. A thread opened from a thread's picker replaces that picker, so `h` goes straight back to the first thread.
- **Conversation.** The title bar shows `project / title ● state`, using the existing state colours. The thread fills the screen and draws its conversation with pi's own components, so it reads exactly like a pi transcript: markdown prose, tool calls with their output, edit diffs, failed commands with their exit codes. Four or more tool calls in a row fold into one line, which opens by itself when a step failed or is running. While the agent works, the editor's top border shows the run's clock and its tool count. An answer streams in as the agent writes it, redrawn at most ten times a second, and the view keeps to its end. Messages waiting for the run show above the editor. A view scrolled up stays put while the answer goes on, until `G` follows the end again.
- **Composer.** Enter sends a message, or queues it while the run is busy, and insert mode lasts past a send. An unsent message stays with its thread while you move between views, such as to the picker and back. A send that failed is put back in the editor, and sending the same text again reuses its request ID, so Nexus never takes it twice. `/steer <text>` joins the current run instead. The other slash commands are `/abort`, `/retry` for parked tasks, `/retry-pylon`, `/start-again`, `/archive`, `/unarchive`, `/delete` (it asks, with Keep first), `/open <port>`, `/unpublish <port>`, `/copy <port or service>`, `/info` and `/close`. A slash the view does not know is sent as a message, as pi does.
- **Actions.** `m` lists the actions that apply to the thread now: watch again after the watch ended, abort the run, retry the parked tasks, retry the pylon, start again, archive or unarchive, copy the attach command, open a session, attach, and delete, which asks with Keep first. `j` and `k` move, Enter runs one, and Esc cancels.
- **States.** A parked run, a failed pylon with its diagnostic and what to do, an archived thread, a deleted one and a paused pylon each show a note above the editor. A thread that cannot take messages refuses them and says why.
- **Changes.** `2` reads the checkout, showing the file count and added/deleted line totals since the pylon booted. Folders merge single-folder chains, sort before files, and fold with Enter or `o`. Files show their status, line counts or `binary`; `j`/`k` select, `y` copies the path, and Enter or `o` opens the diff. A diff shows metadata, hunk headings and the new file’s line numbers, with pi’s own edit-diff colours; long lines are cut, not wrapped. Conversation scroll keys work there. `h` or Esc returns to the tree on that file. Diffs stop at 20,000 rows and report truncation. `c` toggles only uncommitted changes (since HEAD), and `T` the latest turn's changes (since the snapshot taken before the agent's latest reply); pressing the same key again goes back to the boot base. The base is persisted as `base` in `pi-nexus/settings.json`, and the hint line says which is on. A Claude worker thread has no turn snapshots, so `T` there shows the CLI's refusal. `r` reads again.
- **Checkout activity.** Changes reads only after first showing its tab, at agent turn end or changed agent activity with no turn running, and when explicitly refreshed. It never polls. Automatic reads require an open thread and a running pylon. The visit on thread open can wake it independently; Changes waits for it to run before its first checkout read. A non-running pylon explains that reading wakes it; Enter or `r` explicitly wakes and reads, with progress while the CLI waits. Archived threads must be unarchived first; deleted checkouts are gone. The last result remains during a re-read. Reads are serialized, toggles queue the latest base and discard stale replies. A missing boot base keeps the CLI’s refusal and suggests `c`; an older CLI is told to update.
- **Pylon.** `4` or `/info` shows the pylon's wanted and observed state, node, last seen, and human and agent activity, then the outputs, the command that attaches from a shell in the pylon, and the Sessions section below.
- **Previews.** `3` shows the previews as links, with the port each one serves, and the ports that listen with no preview yet, each port once. `j` and `k` select a row, and its hint names the key that acts on it. Enter on a port with no preview, or `/open <port>`, publishes it as a preview, shows it opening while the node gets its URL ready, then links it, or says why it failed. A preview whose service failed in the pylon, or whose port has no route into it, shows failed, with no link, since its URL cannot reach the server, and says why. A preview stays published until `x` on its row or `/unpublish <port>` closes it: the preview shows closing while the CLI wakes a paused pylon and unpublishes it, then the port is back under Ports, or the preview says why it did not close. While a port is being published or unpublished, from the console, a `/nexus` command or a model tool, any other change of that port is refused until it finishes, so an older publish can never undo a newer unpublish. Only a port's own preview, named `port-<port>`, can be unpublished, since the CLI refuses to unpublish a declared or ad hoc service's preview. A link opens on a click, and `y` or `/copy` puts it on the clipboard.
- **Sessions in Pylon.** `4` lists the pylon's Herdr sessions as the dashboard does: each one's harness, title, state, pane and session ID. `n`, `/session`, or Open a session in the actions opens a form in the composer's place: ←→ choose the harness, Claude Code first, Tab moves to the optional title, which is the harness's name when empty, Enter opens and Esc cancels. The session shows opening while the CLI wakes the pylon and starts its agent, which can take a minute, then opened, or the CLI's reason it did not open. `x` asks to close the selected session, with Keep first, since closing ends its agent. A paused pylon lists the sessions its next wake brings back as `paused, resumes on wake`, or `resumes on unarchive` for an archived thread, and `x` says that one can be closed once it runs rather than asking. A session the last wake did not bring back shows as failed with the reason, whole on the selected row, and `x` closes it so that no wake tries it again; one in no pane shows the `failed-` ID that closes it. A close the CLI refuses, such as of a pane a wake has since moved to another, says why in its words and reads the sessions again; nothing tries it again by itself. Enter, `/attach`, or Attach in the actions runs `nexus attach <thread>` in this terminal: pi steps aside, as it does for an external editor, the pylon's Herdr takes the terminal, where each session is a workspace, and pi comes back when you detach from Herdr, with a note of how the attach ended. This is how you log Claude Code in: open a session, attach, pick its workspace and type `/login`. Attaching needs Nexus CLI 0.9.0 or newer and goes through the control plane.
- **Start form.** `/nexus new`, `/nexus new <project>` or `n` in the picker opens a form for the title, project, node, branch and first message. It starts on the selected thread's project, or the project shown. Empty node and branch mean the project's defaults. Under the project it shows the repo URL, or `scratch`, and under the message what the start does, such as `Boots a pylon on firebat and checks out main.` A scratch project's thread starts an empty repository on the branch instead of checking it out. Start again opens it with the thread's project and title, and cancelling it goes back to the thread.
- **Claude worker threads.** A thread whose worker is Claude Code has no agent conversation, and `nexus watch` never streams its work, so its Conversation reads its Claude Code transcript with `nexus conversation`: the prompts, replies, tool calls with their results, background tasks and notices, drawn with pi's components, and the messages Claude queued above the editor. The run, the title's state and the editor's clock follow the transcript's `working`, and the footer names `Claude Code` and its model. The console reads the transcript once on open, every 2 seconds while Claude works, and otherwise only when the thread's details change or after a send, since each read makes the control plane read the pylon; an idle thread costs no reads. `r` reads it again. A failed read says so once and is tried again, after 2 seconds and then twice as long each time, up to a minute. Nothing is read while this terminal is attached to the pylon, and the transcript is read again after. The composer types the message into Claude's session, and says whether Claude queued it for its next step; `/steer` sends the same way. The actions leave out abort and retry, which the harness has only for its own agent.
- **Strip.** From the session's start, one line above pi's editor names the threads of the project shown that need you, then those with a reply nobody has marked seen, then those whose agent works, with how long ago the message it answers came. pi's status line keeps the counts: `nexus 1 working · 1 needs you · 1 new`. Both come from one poll of `nexus threads` every 30 seconds and after each command. `/nexus strip off` hides both and stops the polling, and `/nexus strip on` starts it again. The setting is kept in `pi-nexus/settings.json` in pi's agent directory, so later sessions keep it. pi's RPC mode shows the status line but cannot draw the strip.

Leaving a view never aborts the agent. Opening a thread counts as a visit, as on the dashboard, so a paused pylon wakes. Once Conversation shows a reply nobody has marked seen, the console marks it seen with `nexus seen`, which every client shares and which never wakes a pylon. It counts as shown only while Conversation is the open view, the watch is current and no turn runs; for a Claude worker, only once a transcript read after that reply has been drawn. The console reads the details again first and skips the mark when a newer reply has come, which its own showing marks. `nexus seen` marks the latest reply, so one that lands between that check and the mark is marked too, until the CLI can name the reply shown. A CLI too old to mark it says so once for that view. pi-nexus before 0.10.0 kept its own looks in `pi-nexus/viewed.json` in pi's agent directory; pi-nexus deletes that file once when it loads. The view gets everything through the CLI: `threads`, `projects`, `project add`, `nodes`, `show`, `watch`, `seen`, `conversation`, `changes`, `diff`, `preview`, `unpreview` and the action commands. The console runs at most one checkout read at a time (therefore at most one `changes` and one `diff` child), and aborts it when the thread view or console closes. Without nodes, the start form leaves out node choices, with a note saying why. Without pi's custom UI, as in RPC mode, `/nexus` lists the threads as a note, and `/nexus open` shows the conversation's tail.

## Commands

| Command | What it does |
| --- | --- |
| `/nexus` | Opens the working thread with the picker under it, or the picker |
| `/nexus open <thread>` | Opens the thread view |
| `/nexus new [project]` | Opens the start form |
| `/nexus list [project]` | Lists threads without deleted ones, as a note: ID, status, whether the agent is working, project and title |
| `/nexus new <project> [--title T] <message>` | Starts a thread with a first message, then follows it |
| `/nexus send <thread> <text>` | Sends a message, then follows the thread. A busy agent takes it after its current turn. A Claude worker thread's send says whether Claude queued it and follows nothing, since a watch never sees Claude's reply |
| `/nexus show <thread>` | Shows the thread's state and the tail of its conversation, or of a Claude worker's transcript |
| `/nexus follow <thread>` | Streams new conversation entries into the session until the next turn ends. A Claude worker thread cannot be followed; `/nexus open` shows its transcript |
| `/nexus unfollow [thread]` | Stops one follow, or all of them |
| `/nexus archive <thread>`, `unarchive` | Archives a thread, which pauses its pylon, or brings it back |
| `/nexus retry <thread>` | Runs a conversation's parked tasks again |
| `/nexus retry-pylon <thread>` | Clears a failed pylon so that Nexus boots it again |
| `/nexus abort <thread>` | Aborts the agent's current run |
| `/nexus unpublish <thread> <port>` | Unpublishes the port's preview, so its URL stops answering. A port with no preview is already unpublished, and a service's preview is refused. Publishing the port again may give it a new URL |
| `/nexus delete <thread>` | Deletes a thread and its pylon once you pick Delete. Keep is the highlighted answer, and dismissing the dialog keeps the thread |
| `/nexus strip on`, `off` | Shows or hides, for this and later sessions, the strip of threads that need you, have news or work above the editor |
| `/nexus project` | Says which project the picker, the strip and the status line show |
| `/nexus project <id>`, `all` | Shows one project's threads, or every project's, in this and later sessions |
| `/nexus project add <id> <repo-url> --node <node> [--branch <branch>]` | Adds a project with `nexus project add`, which needs CLI 0.4.0, then shows its threads |
| `/nexus session open <thread> [--harness claude-code\|pi\|shell] [--title T]` | Opens a session in the pylon, Claude Code unless `--harness` names another, which can take a minute |
| `/nexus session close <thread> [id]` | Closes a session by its pane or, for a failed session in no pane, its ID. Closing a pane ends its agent, and closing a failed session stops wakes trying it again. Without an ID it asks which session, with Keep them all first, and leaves out paused sessions, which can be closed once their pylon's wake brings them back |
| `/nexus session attach <thread>` | Gives this terminal to `nexus attach` until you detach from Herdr. A pi without a terminal to give, as in RPC mode, gets the command to run in one |
| `/nexus help` | Lists these commands |

Arguments split as a shell splits them: quotes work anywhere in a word, so `--title="two words"` is one title, a backslash outside single quotes escapes the next character, and a quote left open is refused. A message, the text after `send <thread>` or `new <project>`, is kept as typed, apostrophes and all.

A thread is its ID, such as `th-0123456789ab`, or any unique prefix of it, with or without `th-`. Tab completes command names, the thread IDs last listed, after `project`, `all`, `add` and the projects those threads are on, and after `session`, `open`, `close` and `attach`.

Conversation text appears in the chat as Nexus notes. Pi stores the notes in the session but never sends them to its model. A collapsed note shows its last 16 lines, and `ctrl+o` expands it.

A follow ends when the thread settles as `nexus_wait` judges it, failed pylons included, or with `/nexus unfollow`. After `/nexus new` or `/nexus send`, a reply that arrived before the first poll counts. `/nexus follow` on an idle thread waits for its next turn. A widget above the editor shows each follow's state while it runs. A follow keeps going through a control plane outage and says so in the chat.

While the strip setting is on, which it is unless `/nexus strip off` turned it off, the status line shows from the session's start how many threads of the project shown have a working agent, a Claude worker's included, and how many need you or have a reply nobody has marked seen, such as `nexus 2 working · 1 needs you · 3 new`. It refreshes every 30 seconds and after each command. When the CLI cannot reach Nexus, it shows the failure kind instead, such as `nexus unreachable`.

Every failure is shown as an error notification with the CLI's message. When the SOCKS proxy is down, that message points to `ts-home status`.

## Model tools

Nexus tools are deferred: pi declares them to the model only after its builtin `tool_search` finds them. Search for `nexus`, `thread`, `pylon` or `project`. If that builtin is missing, replaced or inactive, the tools fall back to direct exposure so they remain discoverable. When search becomes active again, only tools activated by that fallback are removed from the active set; tools already active before it stay active.

| Tool | Parameters | Result |
| --- | --- | --- |
| `nexus_projects` | None | The CLI's `Project[]`, including repository URL (null for scratch), default node and branch |
| `nexus_project_add` | `id`, exactly one of `repo_url` or `scratch: true`, `node?`, `branch?`, `cpus?`, `memory_gib?`, `disk_gib?`, `allow_hosts?` (string array), `logins?` (`claude` or `chatgpt` array), `github?` | The CLI's added `Project` JSON. Node defaults to the first online node, branch to `main` |
| `nexus_threads` | `project?` | `[{id, project, title, status, working, active}]`, without deleted threads. `active` reads like `2m ago` |
| `nexus_start` | `project`, `message`, `title?` | `{id, project, title}`. The title defaults to the message's first line |
| `nexus_send` | `thread`, `text` | `{thread, sent: true}`. A working agent takes the message after its current turn |
| `nexus_read` | `thread` | `{thread, status, run, pylon, queued, failed?, ports, conversation}`, with the conversation's last 6000 characters. `ports` lists `{port, service?, url?, ready?, failed?}` for each port that listens, with its preview's URL once it has one and why its service failed when it did, or is null when the node could not read them |
| `nexus_wait` | `thread`, `timeout_seconds?` (1 to 600, default 300) | `{thread, settled, timed_out?, cancelled?, status, run, pylon, queued, failed?, ports, outage?, needs_human?, reply}`. `reply` is the assistant's text since the latest user message, its last 4000 characters, or null. `needs_human` tells the model when parked tasks or a failed pylon need `/nexus retry` or `/nexus retry-pylon` |
| `nexus_preview` | `thread`, `port` (1 to 65535) | `{thread, port, url, ready}`, once the node serves the URL, up to 2 minutes. The preview is open to the home tailnet until it is unpublished with `nexus_unpublish` or `/unpublish` |
| `nexus_unpublish` | `thread`, `port` (1 to 65535) | `{thread, port, unpublished: true}`, once the preview is closed, up to 2 minutes while a paused pylon wakes. A port with no preview succeeds too. A declared or ad hoc service's preview fails with the CLI's refusal. Publishing the port again may give it a new URL |
| `nexus_archive` | `thread` | `{thread, status: "archived"}` |

`nexus_project_add` needs Nexus CLI 0.7.0 or later, which added `--scratch` and `--secret`. `github: true` grants only `GH_TOKEN` to `api.github.com` and `github.com`, like the dashboard's GitHub access checkbox. No other secret name or secret hosts can be supplied; `allow_hosts` allows network access without granting credentials. A CLI without `project add`, or one that rejects `--scratch` or `--secret` as unknown options, gets an error asking to update to CLI 0.7.0 or later. Resource defaults are the CLI's. If no node is online, specify `node` explicitly or bring one online.

Results are compact JSON. A failure is a failed tool call whose text reads `nexus (<kind>): <the CLI's message>`, where the kind is the CLI's, such as `unreachable` or `not-found`.

`nexus_wait` counts a thread as settled at once when it cannot run on: archived, deleted, parked, or its pylon failed. Otherwise its run must be idle with nothing queued, and either the agent has answered the latest message or this wait saw the run working, which covers a turn aborted before it wrote anything. A settling state ends the wait at once, and an entry that looks settled counts after a quiet second. It reads one `nexus watch` and stops it when done. Outages are waited through and reported in `outage`. `reply` joins every assistant text since the latest user message, a blank line apart, and is null when that turn wrote none.

The model cannot delete a thread, retry a pylon, retry parked tasks, or open, close or attach to a session. Those stay human-only, as `/nexus delete`, `/nexus retry-pylon`, `/nexus retry` and `/nexus session`.

These tools match the Claude Code Nexus mod in parameters, results and the wait rule. Only the names differ: the mod's tools show as `mcp__nexus__threads` and so on, because Claude Code namespaces them, and pi does not.

`nexus_read` and `nexus_wait` read `nexus watch`, which never streams a Claude worker's transcript, so they do not see Claude worker threads yet: `nexus_read` shows no messages, and `nexus_wait` waits until it times out with a null `reply`. Teaching them `nexus conversation` is a follow-up made together with the Claude Code mod, so both keep the same wait rule.

## Development

```bash
npm install
npm run check
```

`npm run check` type-checks, runs the tests, and verifies the npm package contents. There is no separate lint command in this repository. The tests drive the tools, commands and console against a fake `nexus` binary that prints contract-shaped JSON, and `test/pi-rpc.test.ts` loads the extension into a real Pi in RPC mode.

`test/demo/` builds the console's screenshot demo. `bun test/demo/build.ts <dir>` writes a fake `nexus` whose working thread holds one scripted conversation, beside a thread with an unseen reply, one whose pylon failed and an archived one, and an empty pi agent directory. Its Changes replies include a merged folder, a binary file, a rename and a unified diff; append `paused` to build the paused-pylon note scenario. `test/demo/faux-model.ts` is a pi extension whose model plays the same conversation, so a real pi session can be put beside the thread view. To see the console against it:

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
